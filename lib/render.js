// Runtime render pass for three.js, shipped as text: `kit render` injects it for a trial, and --apply writes it into the
// project as kit-render.js. It never changes what game code sees (positions, visible, layers, raycasts all stay):
//
//  - Static transforms. An object whose position, rotation, scale and children stay the same for SETTLE renders stops
//    recomputing its matrix, and a subtree that is entirely static is skipped by updateMatrixWorld. Every render first
//    checks the static objects; any change puts the object (and its parents) straight back to normal.
//  - Batching. Static opaque meshes that share a material become one BatchedMesh (one draw call; per-object culling
//    and visibility kept). The originals stay in the scene for game code and raycasts; an empty bounding sphere makes
//    the renderer's frustum test skip them. A member that moves, changes material or geometry, or leaves the scene
//    drops out of its batch and draws itself again.
export function installRender(THREE, opts = {}) {
  const SETTLE = opts.settle ?? 90, MIN = opts.minBatch ?? 8, BATCH = opts.batch === true
  const P = THREE.Object3D.prototype, UMW = P.updateMatrixWorld, UWM = P.updateWorldMatrix
  if (THREE.Scene.prototype.__kitRender) return THREE.Scene.prototype.__kitRender
  const PROBE = 0, FROZEN = 1, MANUAL = 2, GONE = 3
  const HIDDEN = new THREE.Sphere(new THREE.Vector3(), -Infinity)     // fails every frustum test
  const tmp = new THREE.Matrix4(), inv = new THREE.Matrix4()
  const stats = { frozen: 0, skipped: 0, woken: 0, batches: 0, batched: 0, dropped: 0, extraMB: 0, renders: 0 }
  const api = { stats, scenes: [], opts: { settle: SETTLE, minBatch: MIN, batch: BATCH } }

  // ---------- static transforms ----------
  // p, q, k, c: the object's own position, quaternion, scale and children, kept so the per-render check reads
  // one Vector3/Quaternion/Array shape instead of every kind of Object3D
  const record = (S, o) => ({ S, o, p: o.position, q: o.quaternion, k: o.scale, c: o.children, s: new Float64Array(11),
    parent: null, since: S.frame, state: PROBE, gen: 0, skip: false, sub: false, mau: false, hooked: false,
    batch: null, bid: -1, geo: null, vis: true, key: undefined })

  function snap(r) {
    const { p, q, k, s: a } = r
    a[0] = p.x; a[1] = p.y; a[2] = p.z; a[3] = q._x; a[4] = q._y; a[5] = q._z; a[6] = q._w
    a[7] = k.x; a[8] = k.y; a[9] = k.z; a[10] = r.c.length; r.parent = r.o.parent
  }
  // a move to another parent shows up as a children count change on a tracked parent; batches also check parent
  function changed(r) {
    const { p, q, k, s: a } = r
    return p.x !== a[0] || p.y !== a[1] || p.z !== a[2] || q._x !== a[3] || q._y !== a[4] || q._z !== a[5] || q._w !== a[6] ||
      k.x !== a[7] || k.y !== a[8] || k.z !== a[9] || r.c.length !== a[10]
  }

  // own methods on frozen objects: a game call (getWorldPosition, an explicit update) still sees a moved object
  function frozenUMW(force) {
    const r = this.__kit
    if (r && r.state === FROZEN) {
      if (r.S.inPass) { if (r.skip && !force) return }       // checked by this render's poll; whole subtree static
      else if (changed(r)) wake(r)
    }
    return (r ? r.umw : Object.getPrototypeOf(this).updateMatrixWorld).call(this, force)
  }
  function frozenUWM(up, down) {
    const r = this.__kit
    if (r && r.state === FROZEN && changed(r)) wake(r)
    return (r ? r.uwm : Object.getPrototypeOf(this).updateWorldMatrix).call(this, up, down)
  }

  function freeze(r) {
    const o = r.o
    if (!o.matrixAutoUpdate && !r.mau) { r.state = MANUAL; return }     // the app sets this matrix itself
    o.updateMatrix()
    o.matrixAutoUpdate = false
    r.mau = true
    r.state = FROZEN
    // keep the class's own versions: SkinnedMesh and Camera do more than Object3D (bind matrix, view matrix)
    if (!r.hooked) {
      const proto = Object.getPrototypeOf(o)
      r.umw = o.updateMatrixWorld === frozenUMW ? proto.updateMatrixWorld : o.updateMatrixWorld   // re-added objects keep our hook
      r.uwm = o.updateWorldMatrix === frozenUWM ? proto.updateWorldMatrix : o.updateWorldMatrix
      o.updateMatrixWorld = frozenUMW
      o.updateWorldMatrix = frozenUWM
      r.hooked = true
    }
    r.S.frozen.push(r)
    r.S.subDirty = true
    stats.frozen++
  }

  function wake(r) {
    const o = r.o
    if (r.mau) o.matrixAutoUpdate = true
    o.matrixWorldNeedsUpdate = true
    r.state = PROBE
    r.key = undefined
    r.since = r.S.frame
    snap(r)
    r.S.probation.push(r)
    for (let p = o; p && p.__kit; p = p.parent) { p.__kit.skip = false; p.__kit.sub = false }
    unbatchTree(o)            // its world matrix (and its children's) is about to change
    stats.frozen--
    stats.woken++
  }

  // post-order: a frozen object whose children are all static (recursively) can skip its whole subtree
  function markStatic(o) {
    let all = true
    for (const c of o.children) if (!c.__kitBatch && !markStatic(c)) all = false
    const r = o.__kit
    const sub = !!r && r.state === FROZEN && all
    if (r) { r.sub = sub; r.skip = sub }
    return sub
  }

  // ---------- batching ----------
  function keyOf(o) {
    const g = o.geometry, m = o.material
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh || o.morphTargetInfluences || !o.frustumCulled) return null
    if (!m || Array.isArray(m) || m.transparent || m.isShaderMaterial || !g?.isBufferGeometry || !g.attributes.position) return null
    if (o.onBeforeRender !== P.onBeforeRender || o.onAfterRender !== P.onAfterRender || Object.keys(g.morphAttributes).length) return null
    const attrs = []
    for (const n of Object.keys(g.attributes).sort()) {
      const a = g.attributes[n]
      if (a.isInterleavedBufferAttribute) return null
      attrs.push(`${n}${a.itemSize}${a.normalized ? 'n' : ''}${a.array.constructor.name}`)
    }
    return `${m.id}|${o.castShadow}${o.receiveShadow}|${o.layers.mask}|${o.renderOrder}|${attrs}|${g.index ? g.index.array.constructor.name : '-'}`
  }

  // every ancestor up to the scene is static, so the world matrix can't change without one of them waking
  function staticChain(o, scene) {
    for (let p = o.parent; p !== scene; p = p.parent) if (!p || p.__kit?.state !== FROZEN) return false
    return true
  }

  function visibleIn(o, scene) {
    let v = o.visible, p = o.parent
    for (; p && p !== scene; p = p.parent) if (!p.visible) v = false
    return p === scene ? v : null          // null: no longer in this scene
  }

  function batchAll(S) {
    const groups = new Map()
    for (const r of S.frozen) {
      if (r.state !== FROZEN || r.batch || !r.o.isMesh || !staticChain(r.o, S.scene)) continue
      const k = r.key === undefined ? (r.key = keyOf(r.o)) : r.key      // cached until the object wakes
      if (k) groups.has(k) ? groups.get(k).push(r) : groups.set(k, [r])
    }
    for (const list of groups.values()) if (list.length >= MIN) build(S, list)
  }

  function build(S, list) {
    const o0 = list[0].o, geos = new Map()
    let V = 0, I = 0, bytes = 0
    for (const { o: { geometry: g } } of list) if (!geos.has(g)) {
      geos.set(g, -1)
      V += g.attributes.position.count
      I += g.index ? g.index.count : 0
      for (const a of Object.values(g.attributes)) bytes += a.array.byteLength
    }
    const B = new THREE.BatchedMesh(list.length, V, I || V * 2, o0.material)
    Object.assign(B, { name: 'kit:batch', __kitBatch: true, sortObjects: false, castShadow: o0.castShadow, receiveShadow: o0.receiveShadow, renderOrder: o0.renderOrder, matrixAutoUpdate: false })
    B.layers.mask = o0.layers.mask
    B.raycast = () => {}                   // game raycasts keep hitting the originals
    for (const g of geos.keys()) geos.set(g, B.addGeometry(g))
    inv.copy(S.scene.matrixWorld).invert()
    for (const r of list) {
      r.bid = B.addInstance(geos.get(r.o.geometry))
      B.setMatrixAt(r.bid, tmp.multiplyMatrices(inv, r.o.matrixWorld))
      r.vis = visibleIn(r.o, S.scene) === true
      B.setVisibleAt(r.bid, r.vis)
      r.batch = B
      r.geo = r.o.geometry
      r.o.boundingSphere = HIDDEN
    }
    S.scene.add(B)
    S.batches.push({ B, members: list })
    stats.batches++
    stats.batched += list.length
    stats.extraMB += bytes / 1048576
  }

  function unbatch(r) {
    if (!r.batch) return
    r.batch.deleteInstance(r.bid)
    r.batch = null
    r.o.boundingSphere = undefined         // undefined (not delete): the frustum test goes back to the geometry's sphere
    stats.batched--
    stats.dropped++
  }
  function unbatchTree(o) {
    if (o.__kit?.batch) unbatch(o.__kit)
    for (const c of o.children) unbatchTree(c)
  }

  // after the matrices are updated, before the renderer culls: keep each batch in step with its originals
  function sync(S) {
    for (const b of S.batches) {
      let w = 0
      for (const r of b.members) {
        if (!r.batch) continue
        const o = r.o
        if (r.state !== FROZEN || o.parent !== r.parent || o.material !== b.B.material || o.geometry !== r.geo || !o.frustumCulled ||
          o.castShadow !== b.B.castShadow || o.receiveShadow !== b.B.receiveShadow) { unbatch(r); continue }
        const v = visibleIn(o, S.scene)
        if (v === null) { unbatch(r); continue }
        if (v !== r.vis) { b.B.setVisibleAt(r.bid, v); r.vis = v }
        b.members[w++] = r
      }
      b.members.length = w
      if (!w) { S.scene.remove(b.B); b.B.dispose(); b.dead = true; stats.batches-- }
    }
    if (S.batches.some(b => b.dead)) S.batches = S.batches.filter(b => !b.dead)
  }

  // ---------- per scene ----------
  function discover(S) {
    const gen = ++S.gen
    const visit = o => {
      if (o.__kitBatch) return
      let r = o.__kit
      if (!r || r.state === GONE) { r = o.__kit = record(S, o); snap(r); S.probation.push(r) }
      r.gen = gen
      for (const c of o.children) visit(c)
    }
    for (const c of S.scene.children) visit(c)
  }
  // an object that left the scene goes back to how it was
  function release(r) {
    if (r.state === FROZEN) { stats.frozen--; if (r.mau) r.o.matrixAutoUpdate = true }
    unbatch(r)
    r.state = GONE
    r.o.__kit = null
  }

  function tick(S) {
    S.frame++
    stats.renders++
    if (S.frame % SETTLE === 1) discover(S)
    const swept = S.frame % SETTLE === 1
    let w = 0
    for (const r of S.frozen) {
      if (r.state !== FROZEN) continue
      if (swept && r.gen !== S.gen) { release(r); continue }
      if (changed(r)) { wake(r); continue }
      S.frozen[w++] = r
    }
    S.frozen.length = w
    const still = []
    for (const r of S.probation) {
      if (r.state !== PROBE) continue
      if (swept && r.gen !== S.gen) { release(r); continue }
      if (changed(r)) { snap(r); r.since = S.frame }
      else if (S.frame - r.since >= SETTLE) { freeze(r); if (r.state !== PROBE) continue }
      still.push(r)
    }
    S.probation = still
    if (S.subDirty && S.frame % SETTLE === 0) {
      S.subDirty = false
      let n = 0
      for (const c of S.scene.children) if (!c.__kitBatch) markStatic(c)
      for (const r of S.frozen) if (r.skip) n++
      stats.skipped = n
    }
    if (api.opts.batch && S.frame >= 2 * SETTLE && S.frame % (2 * SETTLE) === 0) batchAll(S)
  }

  // clone()/copy() carry matrixAutoUpdate over, so a copy of a frozen template would never follow its own position
  const COPY = P.copy
  P.copy = function (source, recursive) {
    const out = COPY.call(this, source, recursive)
    if (source.__kit?.mau && source.__kit.state === FROZEN) this.matrixAutoUpdate = true
    return out
  }

  const SceneUMW = THREE.Scene.prototype.hasOwnProperty('updateMatrixWorld') ? THREE.Scene.prototype.updateMatrixWorld : UMW
  THREE.Scene.prototype.updateMatrixWorld = function (force) {
    let S = this.__kitS
    if (!S) {
      S = this.__kitS = { scene: this, frame: 0, gen: 0, frozen: [], probation: [], batches: [], subDirty: false, inPass: false }
      S.root = record(S, this)
      api.scenes.push(S)
    }
    tick(S)
    // a scene that recomposes its own matrix marks itself changed, which forces every child to update: skip that
    // while the scene itself hasn't moved
    const moved = changed(S.root), mau = this.matrixAutoUpdate
    if (moved) snap(S.root)
    else if (mau && !this.matrixWorldNeedsUpdate) this.matrixAutoUpdate = false
    S.inPass = true
    try { SceneUMW.call(this, force) } finally { S.inPass = false; this.matrixAutoUpdate = mau }
    if (S.batches.length) sync(S)
  }
  THREE.Scene.prototype.__kitRender = api
  globalThis.__kitRender = api
  return api
}

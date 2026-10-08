// Runs inside the page before any of its scripts (page.evaluateOnNewDocument). It owns requestAnimationFrame, so it
// can measure every frame, drive scripted input, and control the timestamps the game sees:
//   real    timestamps as Chrome gives them
//   fixed   1/60 s per frame whatever the real gap, so a scenario plays out the same every run (perf runs)
//   hold    the same timestamp every frame, so dt = 0 and the game stands still (between ready and a run)
//   replay  the frame times of a recording, so the game steps exactly as it did when recorded
// Math.random is a seeded generator, and from go() on setTimeout / setInterval run on the game clock (fired at frame
// starts), so a run from the same start state plays out the same way.
// Everything is reached through window.__kit.
export function probe(opts) {
  const fn = s => s && new Function(`return (${s})`)()
  const ready = fn(opts.ready), renderer = fn(opts.renderer), state = fn(opts.state)
  const realRaf = window.requestAnimationFrame.bind(window)
  const now = performance.now.bind(performance)
  const realTimeout = window.setTimeout.bind(window), realInterval = window.setInterval.bind(window)
  const realClear = window.clearTimeout.bind(window)

  // Until go(), timers are real but tracked, so go() can move the pending ones onto the game clock.
  const live = new Map()
  window.setTimeout = (cb, ms, ...args) => {
    const id = realTimeout((...a) => { live.delete(id); if (typeof cb === 'function') cb(...a) }, ms, ...args)
    live.set(id, { cb, args, every: 0, due: now() + (+ms || 0) })
    return id
  }
  window.setInterval = (cb, ms, ...args) => {
    const id = realInterval((...a) => { live.get(id).due = now() + (+ms || 0); if (typeof cb === 'function') cb(...a) }, ms, ...args)
    live.set(id, { cb, args, every: Math.max(1, +ms || 0), due: now() + (+ms || 0) })
    return id
  }
  window.clearTimeout = window.clearInterval = id => { live.delete(id); realClear(id) }

  // seeded Math.random (mulberry32); with opts.traceRandom each call's call site is counted (kit.takeSites())
  let seed = 1
  const sites = new Map(), order = []
  // "direct < caller < its caller  [entry: what started this JS task]": the frame tick, a timer, an event...
  const clean = l => (l || '').trim().replace(/^at /, '').replace(/https?:\/\/127\.0\.0\.1:\d+\//, '').replace(/ \((.*)\)$/, ' $1')
  const site = () => {
    const lines = new Error().stack.split('\n').slice(3)
    return `${lines.slice(0, 3).map(clean).join(' < ')}  [entry: ${clean(lines.at(-1))}]`
  }
  if (opts.traceRandom) Error.stackTraceLimit = 60
  Math.random = () => {
    if (opts.traceRandom) { const k = site(); sites.set(k, (sites.get(k) || 0) + 1); order.push(k) }
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // one real rAF per frame runs every queued callback with the timestamp the clock picks
  let queue = [], ids = 0, scheduled = false
  window.requestAnimationFrame = cb => {
    queue.push([++ids, cb])
    if (!scheduled) { scheduled = true; realRaf(tick) }
    return ids
  }
  window.cancelAnimationFrame = id => { queue = queue.filter(q => q[0] !== id) }

  const kit = window.__kit = {
    mode: opts.mode || 'real', frame: 0, labels: [], ready: false, given: 0, drive: null,
    seed(n) { seed = n | 0 },
    // counts per call site since the last take; the call order stays here (kit.orders[i]) as it is too big to send
    takeSites() {
      const counts = Object.fromEntries(sites)
      kit.orders.push(order.splice(0))
      sites.clear()
      return counts
    },
    orders: [],
    rng: () => seed,                                     // generator state: differs between two runs once randomness was drawn differently
    // switch clock mode and reseed; drive(f) counts frames from here
    go(mode, s) { if (s !== undefined) kit.seed(s); virtualTimers(); kit.f0 = kit.frame; kit.resume = mode === 'real'; kit.mode = mode },
    f0: 0,
    measure: null, rec: null, play: null,
  }

  // performance.now on the game clock too, for apps that take dt from THREE.Clock: the frame's timestamp plus the real
  // time since the frame began (so ms budgets still work), never going backwards; time spent frozen does not count.
  let frameStart = 0, lastPerf = 0
  performance.now = () => {
    if (kit.mode === 'real') return now()
    return lastPerf = Math.max(lastPerf, kit.given + (kit.frozen ? 0 : now() - frameStart))
  }

  // Date.now too: a fixed epoch plus game time, so apps that seed state from the date start the same each run
  const realDateNow = Date.now, epoch = opts.epoch ?? Date.UTC(2026, 0, 1)
  Date.now = () => (kit.mode === 'real' ? realDateNow() : epoch + Math.round(kit.given))   // frame time only: exact

  let lastReal = 0
  function tick(real) {
    scheduled = false
    if (kit.frozen) return                               // callbacks stay queued until kit.runTo() resumes
    const list = queue
    queue = []
    let froze = false
    if (!kit.ready && ready?.()) { kit.ready = true; froze = !!opts.freezeAtReady }
    const t = kit.given = clock(real)
    frameStart = now()
    fireTimers(t)
    before()
    const t0 = now()
    for (const [, cb] of list) {
      try { cb(t) } catch (e) { realTimeout(() => { throw e }) }
    }
    after(real, now() - t0)
    lastReal = real
    kit.frame++
    if (froze) { kit.mode = 'hold'; kit.frozen = true; virtualTimers() }   // nothing runs or draws random numbers until runTo()
    if (kit.stopAt !== null && kit.frame - kit.f0 >= kit.stopAt) { kit.frozen = true; kit.stopAt = null; kit.onFrozen?.() }
  }

  // ---------- timers on the game clock ----------
  // Pending real timers move over keeping their ids and remaining delay; new ones get ids from 1e9 up.
  const timers = new Map()
  let timerId = 1e9, virtual = false
  function virtualTimers() {
    if (virtual) return
    virtual = true
    for (const [id, x] of live) {
      realClear(id)
      if (typeof x.cb === 'function') timers.set(id, { at: kit.given + Math.max(0, x.due - now()), cb: x.cb, args: x.args, every: x.every })
    }
    live.clear()
    const add = (cb, ms, args, every) => {
      if (typeof cb !== 'function') return 0
      timers.set(++timerId, { at: kit.given + Math.max(0, +ms || 0), cb, args, every })
      return timerId
    }
    window.setTimeout = (cb, ms, ...args) => add(cb, ms, args, 0)
    window.setInterval = (cb, ms, ...args) => add(cb, ms, args, Math.max(1, +ms || 0))
    window.clearTimeout = window.clearInterval = id => { timers.delete(id) }
    window.requestIdleCallback = (cb, o) => add(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 0, [], 0)
    window.cancelIdleCallback = window.clearTimeout
  }

  // Run every timer due by time t, in due order; ones they add fire on a later frame.
  function fireTimers(t) {
    if (!timers.size) return
    const due = [...timers].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
    for (const [id, x] of due) {
      if (!timers.has(id)) continue
      if (x.every) x.at += x.every * Math.max(1, Math.ceil((t - x.at) / x.every))
      else timers.delete(id)
      try { x.cb(...x.args) } catch (e) { realTimeout(() => { throw e }) }
    }
  }

  // Run until frame n (counted from go()) and freeze there exactly: nothing of the page's rAF work runs while frozen.
  kit.stopAt = null
  kit.runTo = n => new Promise(done => {
    if (kit.frame - kit.f0 >= n) { kit.frozen = true; return done() }
    kit.stopAt = n
    kit.onFrozen = done
    if (kit.frozen) { kit.frozen = false; lastReal = 0; if (queue.length && !scheduled) { scheduled = true; realRaf(tick) } }
  })

  // Leaving hold, real time resumes one frame after the held stamp, so the game sees no jump.
  let offset = 0
  function clock(real) {
    if (kit.mode === 'hold') return kit.given || real
    if (kit.mode === 'fixed') return (kit.given || real) + 1000 / 60
    if (kit.resume) { offset = real - kit.given - 1000 / 60; kit.resume = false }
    if (kit.mode === 'replay' && kit.play) {
      const dt = kit.play.data.dt[kit.play.f]
      if (dt !== undefined) return kit.given + dt
      kit.mode = 'hold'                                  // recording ran out: stand still
      return kit.given
    }
    return real - offset
  }

  // ---------- per-frame hooks ----------

  function before() {
    const r = kit.measure && renderer?.()
    if (r) { r.info.autoReset = false; r.info.reset() }
    // drive(f) may return a label for what it did this frame; perf --hitches names hitches by the last label
    if (kit.drive) try { const label = kit.drive(kit.frame - kit.f0); if (typeof label === 'string') kit.labels.push([kit.frame - kit.f0, label]) } catch (e) { kit.driveError = String(e) }
    if (kit.mode === 'replay') replayFrame()
  }

  function after(real, cpu) {
    const m = kit.measure
    if (m && m.n < m.cap) {
      const i = m.n++, r = renderer?.()
      m.gap[i] = lastReal ? real - lastReal : 0
      m.cpu[i] = cpu
      m.heap[i] = performance.memory?.usedJSHeapSize ?? 0
      if (r) { m.calls[i] = r.info.render.drawCalls ?? r.info.render.calls; m.tris[i] = r.info.render.triangles }   // WebGPU (render.calls there counts render() calls) ?? WebGL
    }
    if (kit.rec) {
      kit.rec.dt.push(kit.given - kit.rec.lastGiven)
      kit.rec.lastGiven = kit.given
      checkpoint(kit.rec, kit.rec.dt.length)
    }
    if (kit.play) checkpoint(kit.play, ++kit.play.f)
    if (kit.diag) diagFrame()
  }

  // ---------- measuring ----------

  kit.startMeasure = (cap = 20000) => {
    const a = () => new Float32Array(cap)
    kit.measure = { n: 0, cap, gap: a(), cpu: a(), heap: new Float64Array(cap), calls: a(), tris: a() }
  }
  kit.framesFrom = () => kit.frame - kit.f0
  kit.stopMeasure = () => {
    const m = kit.measure
    kit.measure = null
    const cut = arr => Array.from(arr.subarray(0, m.n))
    return { n: m.n, gap: cut(m.gap), cpu: cut(m.cpu), heap: cut(m.heap), calls: cut(m.calls), tris: cut(m.tris) }
  }
  const programCount = info => info.programs?.length ?? info.memory.programs ?? 0   // WebGL list, WebGPU count
  kit.counts = () => {
    const info = renderer?.()?.info
    return info && { programs: programCount(info), geometries: info.memory.geometries, textures: info.memory.textures }
  }

  // ---------- scene diagnosis ----------
  // Over n frames, which materials make three.js re-pick their shader program (getParameters + cache key, every
  // frame they churn) and why: material.version bumped (needsUpdate), the lights state changed (a light added,
  // removed, shown or hidden), or the output colour space flipped (one material drawn to the screen and a target).
  // Also a census of the scene graph.
  const scenes = fn(opts.scenes)
  kit.diagnose = (n = 30) => new Promise(done => { kit.diag = { left: n, n, seen: new Map(), up: new Map(), queue: new Map(), done } })

  // WebGPU: every queue.writeBuffer during the diagnosis, by the three.js function and project function behind it
  const gpuWrite = window.GPUQueue?.prototype.writeBuffer
  if (gpuWrite) GPUQueue.prototype.writeBuffer = function (buf, off, data, dOff, size) {
    if (!kit.diag) return gpuWrite.apply(this, arguments)
    const t = now()
    const out = gpuWrite.apply(this, arguments)
    const ms = now() - t, bytes = size ?? data.byteLength ?? 0
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 60
    const lines = new Error().stack.split('\n').slice(2).map(clean)
    Error.stackTraceLimit = limit
    const lib = lines.find(l => /three/.test(l)) || lines[0], mine = lines.find(l => !/three|<anonymous>/.test(l)) || '?'
    const k = `${buf.label ? `"${buf.label}" ` : ''}${Math.round(buf.size / 1024)} KB buffer, ${lib.split(' ')[0]} via ${mine}`, q = kit.diag.queue.get(k) || { calls: 0, bytes: 0, ms: 0 }
    q.calls++; q.bytes += bytes; q.ms += ms
    kit.diag.queue.set(k, q)
    return out
  }

  function diagFrame() {
    const r = renderer?.(), d = kit.diag
    if (!r) return
    for (const root of scenes?.() || []) root?.traverse(o => {
      if (o.geometry) watchUploads(o, d)
      if (!o.material) return
      for (const m of [o.material].flat()) {
        for (const k in m) if (m[k]?.isTexture) watchUpload(d, m[k], m[k].image?.data?.byteLength ?? (m[k].image?.width * m[k].image?.height * 4 || 0), `${m.name || m.type}.${k} on ${where(o)}`)
        const p = r.properties?.get(m) ?? {}, cur = [m.version, p.lightsStateVersion, p.outputColorSpace]   // WebGPU: version only
        const s = d.seen.get(m)
        if (!s) { d.seen.set(m, { cur, version: 0, lights: 0, colorSpace: 0, name: `${m.name || m.type} on ${where(o)}` }); continue }
        if (cur[0] !== s.cur[0]) s.version++
        if (cur[1] !== s.cur[1]) s.lights++
        if (cur[2] !== s.cur[2]) s.colorSpace++
        s.cur = cur
      }
    })
    if (--d.left > 0) return
    kit.diag = null
    const churn = { version: [], lights: [], colorSpace: [] }
    for (const s of d.seen.values()) for (const k in churn) if (s[k] >= d.n / 3) churn[k].push(s.name)
    // buffers and textures re-uploaded on at least a third of the frames, biggest bytes per frame first
    const uploads = [...d.up.values()].filter(u => u.n >= d.n / 3).map(u => ({ name: u.name, kb: Math.round(u.bytes * u.n / d.n / 1024) }))
      .sort((a, b) => b.kb - a.kb)
    const writes = [...d.queue].map(([k, q]) => ({ site: k, calls: Math.round(q.calls / d.n), kb: Math.round(q.bytes / d.n / 1024), ms: +(q.ms / d.n).toFixed(2) }))
      .sort((a, b) => b.ms - a.ms).slice(0, 6)
    d.done({ census: census(r), churn, uploads, writes, frames: d.n })
  }

  // A geometry's attributes (interleaved ones by their shared buffer) and index: version bumps mean a GPU upload.
  function watchUploads(o, d) {
    const g = o.geometry
    for (const [k, a] of [...Object.entries(g.attributes), ['index', g.index]]) {
      if (!a) continue
      const buf = a.isInterleavedBufferAttribute ? a.data : a
      const part = buf.updateRanges?.length ? buf.updateRanges.reduce((n, r) => n + r.count, 0) * buf.array.BYTES_PER_ELEMENT : 0
      watchUpload(d, buf, part || buf.array.byteLength, `${g.name || g.type}.${k} on ${where(o)}`)
    }
  }

  function watchUpload(d, x, bytes, name) {
    const u = d.up.get(x)
    if (!u) return d.up.set(x, { v: x.version, n: 0, bytes, name })
    if (x.version !== u.v) { u.n++; u.v = x.version; u.bytes = Math.max(u.bytes, bytes) }
  }

  // The first few named objects up the tree: "Mesh < lamp_glass < zone:generator".
  function where(o) {
    const names = []
    for (let p = o; p && names.length < 3; p = p.parent) if (p.name || p === o) names.push(p.name || p.type)
    return names.join(' < ')
  }

  function census(r) {
    const c = { objects: 0, meshes: 0, visibleMeshes: 0, instanced: 0, lights: 0, shadowLights: 0, materials: new Set(), transparent: 0 }
    for (const root of scenes?.() || []) root?.traverse(o => {
      c.objects++
      if (o.isLight && o.visible) { c.lights++; if (o.castShadow) c.shadowLights++ }
      if (!o.isMesh) return
      c.meshes++
      if (o.isInstancedMesh) c.instanced++
      let v = true
      for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break }
      if (v) c.visibleMeshes++
      for (const m of [o.material].flat()) { c.materials.add(m); if (v && m.transparent) c.transparent++ }
    })
    return { ...c, materials: c.materials.size, programs: programCount(r.info) }
  }

  // ---------- record / replay ----------
  // A recording is { seed, dt: [ms per frame], events: [[frame, type, ...fields]], checks: [[frame, state]] }.

  const EVENTS = ['keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'wheel']
  const CHECK_EVERY = 30
  const snap = () => { try { return JSON.parse(JSON.stringify(state?.() ?? null)) } catch { return null } }

  function checkpoint(run, f) {
    if (f % CHECK_EVERY) return
    if (run === kit.rec) run.checks.push([f, snap()])
    else {
      const want = run.data.checks.find(c => c[0] === f)
      if (want && !run.diverged) {
        const got = snap(), diff = firstDiff(want[1], got)
        if (diff) run.diverged = { frame: f, ...diff }
      }
    }
  }

  function firstDiff(a, b, at = '') {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-4 * Math.max(1, Math.abs(a)) ? { path: at, want: a, got: b } : null
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], at ? `${at}.${k}` : k); if (d) return d }
      return null
    }
    return a === b ? null : { path: at, want: a, got: b }
  }

  const record = e => {
    if (!kit.rec || !e.isTrusted) return
    if (e.code === 'F8') { if (e.type === 'keydown') kit.recDone = true; return }   // F8 ends a recording
    const f = kit.rec.dt.length
    if (e.type.startsWith('key')) kit.rec.events.push([f, e.type, e.code, e.key, e.ctrlKey, e.shiftKey, e.altKey])
    else if (e.type === 'wheel') kit.rec.events.push([f, e.type, e.deltaY])
    else kit.rec.events.push([f, e.type, e.button, e.movementX, e.movementY, e.clientX, e.clientY])
  }
  for (const t of EVENTS) addEventListener(t, record, true)
  document.addEventListener('pointerlockchange', () => kit.rec?.events.push([kit.rec.dt.length, 'lock', !!document.pointerLockElement]))

  kit.startRecording = (s = 1) => {
    kit.go('real', s)
    kit.rec = { seed: s, dt: [], events: [], checks: [[0, snap()]], lastGiven: kit.given, locked: !!document.pointerLockElement }
  }
  kit.stopRecording = () => {
    const { seed: s, dt, events, checks, locked } = kit.rec
    kit.rec = null
    kit.mode = 'hold'
    return { seed: s, locked, dt: dt.map(v => +v.toFixed(3)), events, checks }
  }

  // Pointer lock can't be granted headless: pretend, and tell the page it changed.
  let fakeLock = null
  const setLock = on => {
    fakeLock = on ? document.querySelector('canvas') || document.body : null
    document.dispatchEvent(new Event('pointerlockchange'))
  }

  kit.startReplay = data => {
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => fakeLock, configurable: true })
    Element.prototype.requestPointerLock = function () { setLock(true); return Promise.resolve() }
    Document.prototype.exitPointerLock = () => setLock(false)
    kit.seed(data.seed)
    kit.play = { data, f: 0, e: 0, diverged: null }
    kit.f0 = kit.frame                                   // runTo(n) counts replayed frames
    if (data.locked) setLock(true)
    const d0 = firstDiff(data.checks[0]?.[1], snap())
    if (d0) kit.play.diverged = { frame: 0, ...d0 }
    kit.mode = 'replay'
  }
  kit.replayStatus = () => kit.play && { frame: kit.play.f, of: kit.play.data.dt.length, diverged: kit.play.diverged, done: kit.play.f >= kit.play.data.dt.length }

  function replayFrame() {
    const p = kit.play, ev = p.data.events
    while (p.e < ev.length && ev[p.e][0] <= p.f) dispatch(ev[p.e++])
  }

  function dispatch([, type, ...a]) {
    if (type === 'lock') return setLock(a[0])
    if (type.startsWith('key')) {
      const [code, key, ctrlKey, shiftKey, altKey] = a
      const el = document.activeElement || document.body
      el.dispatchEvent(new KeyboardEvent(type, { code, key, ctrlKey, shiftKey, altKey, bubbles: true }))
    } else if (type === 'wheel') (fakeLock || document.body).dispatchEvent(new WheelEvent('wheel', { deltaY: a[0], bubbles: true }))
    else {
      const [button, movementX, movementY, clientX, clientY] = a
      const target = fakeLock || document.elementFromPoint(clientX, clientY) || document.body
      target.dispatchEvent(new MouseEvent(type, { button, movementX, movementY, clientX, clientY, bubbles: true }))
    }
  }
}

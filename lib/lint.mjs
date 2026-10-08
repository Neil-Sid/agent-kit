// kit lint: static checks for the three.js performance mistakes agents make most, focused on code that runs every
// frame. It builds a call graph from the per-frame entry points (config.lint.roots: functions whose callback runs each
// frame, e.g. requestAnimationFrame) through imports and method calls, and reports each finding with the chain that
// makes it hot. Over-approximate on purpose: a method call reaches every project method of that name.
//
// Silence a line with a comment on it or the line above:  // kit-ignore  or  // kit-ignore rule-name
import fs from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'

const MATH = /^(Vector[234]|Matrix[34]|Quaternion|Euler|Color|Box[23]|Sphere|Ray|Plane|Frustum|Raycaster|Line3|Triangle|Spherical)$/
const GPU = /(Geometry|Material|Texture|RenderTarget|Light)$|^(Mesh|InstancedMesh|SkinnedMesh|Group|Object3D|Sprite|Points|Line|LineSegments)$/
const ITER = new Set(['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'flatMap', 'sort', 'traverse', 'traverseVisible'])
const LAYOUT = new Set(['getBoundingClientRect', 'getComputedStyle', 'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'clientWidth', 'clientHeight', 'scrollHeight'])
const ALLOC_ARRAY = new Set(['map', 'filter', 'slice', 'concat', 'flatMap', 'flat'])

const RULES = {
  'gpu-object':       ['warn', 'creates a GPU resource every time it runs: build once and reuse, or pool'],
  'alloc-math':       ['warn', 'allocates a math object per call: hoist a module-level scratch object and reuse it'],
  'alloc-clone':      ['warn', '.clone() allocates per call: copy into a reused scratch object'],
  'material-update':  ['warn', 'material.needsUpdate re-picks the shader program (and may recompile): set it once, not per frame'],
  'layout-read':      ['warn', 'reads layout, which can force a synchronous style/layout pass every frame: cache it on resize'],
  'dynamic-usage':    ['warn', 'WebGPURenderer re-sends DynamicDrawUsage buffers in full on every draw: leave usage static, needsUpdate already uploads changes'],
  'double-pass':      ['warn', 'transparent + DoubleSide draws twice and re-picks the shader both times: add forceSinglePass: true or pick one side'],
  'alloc-typed':      ['warn', 'allocates a typed array / Array per call: allocate once and reuse'],
  'traverse':         ['info', 'walks a whole subtree every frame: keep a flat list of the objects that need the update'],
  'alloc-array':      ['info', 'allocates a new array per call (GC pressure in hot code): loop instead, or reuse a buffer'],
  'json':             ['info', 'JSON work per frame allocates heavily'],
  'dom-write':        ['info', 'innerHTML per frame re-parses and re-lays out: update textContent, or only when the value changes'],
}

// ---------- parsing and indexing ----------

function files(dir, include) {
  const out = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.m?js$/.test(e.name)) out.push(p)
    }
  }
  for (const i of include) { const p = path.join(dir, i); if (fs.existsSync(p)) fs.statSync(p).isDirectory() ? walk(p) : out.push(p) }
  return out
}

// Visit every child node.
function children(node, fn) {
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end') continue
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') fn(c) }
    else if (v && typeof v.type === 'string') fn(v)
  }
}
const isFn = n => /Function/.test(n.type)
const nameOf = n => n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' && !n.computed ? n.property.name : null

// One record per function: where it is, what it calls, and its body for the rule checks.
function indexFile(file, rel, project) {
  const src = fs.readFileSync(file, 'utf8')
  let ast
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }) }
  catch (e) { project.errors.push(`${rel}: parse error ${e.message}`); return }
  const mod = { rel, ast, src: src.split('\n'), fns: new Map(), imports: new Map(), exports: new Map(), all: [] }
  project.mods.set(path.resolve(file), mod)

  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') for (const s of n.specifiers)
      mod.imports.set(s.local.name, { from: path.resolve(path.dirname(file), n.source.value), name: s.imported?.name ?? 'default' })
    const d = n.type.startsWith('Export') ? n.declaration : n
    if (n.type === 'ExportNamedDeclaration') for (const s of n.specifiers || []) mod.exports.set(s.exported.name, s.local.name)
    if (d?.type === 'FunctionDeclaration') { mod.fns.set(d.id.name, d); if (d !== n) mod.exports.set(d.id.name, d.id.name) }
    if (d?.type === 'VariableDeclaration') for (const v of d.declarations)
      if (v.init && isFn(v.init) && v.id.type === 'Identifier') { mod.fns.set(v.id.name, v.init); if (d !== n) mod.exports.set(v.id.name, v.id.name) }
  }

  // name every function, note its calls and the callbacks it hands to iteration methods
  const visit = (node, owner, label) => {
    if (isFn(node)) {
      const f = { node, mod, name: label || node.id?.name || `(anon in ${owner?.name ?? 'module'})`, calls: [], iter: [], roots: [] }
      project.fnOf.set(node, f)
      mod.all.push(f)
      owner = f
    }
    if (node.type === 'MethodDefinition' || (node.type === 'Property' && isFn(node.value))) {
      const cls = node.type === 'MethodDefinition' ? project.classStack.at(-1) : null
      const key = node.key.name ?? node.key.value
      const f = visit(node.value, owner, cls ? `${cls}.${key}` : key)
      ;(project.methods.get(key) ?? project.methods.set(key, []).get(key)).push(project.fnOf.get(node.value))
      return f
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') project.classStack.push(node.id?.name ?? 'class')
    if (node.type === 'VariableDeclarator' && node.init && isFn(node.init) && node.id.type === 'Identifier') {
      visit(node.init, owner, node.id.name)
      return
    }
    if (node.type === 'CallExpression') {
      const callee = nameOf(node.callee)
      if (callee) owner?.calls.push({ name: callee, member: node.callee.type === 'MemberExpression' })
      const [arg] = node.arguments
      if (callee && project.rootNames.has(callee) && arg) project.rootRefs.push({ mod, arg })
      if (callee && ITER.has(callee) && node.callee.type === 'MemberExpression') for (const a of node.arguments) if (isFn(a)) owner?.iter.push(a)
    }
    children(node, c => visit(c, owner))
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') project.classStack.pop()
  }
  visit(ast, null)
}

// The function a plain call to `name` inside mod refers to: a top-level function there, or an imported one.
function resolve(project, mod, name, seen = 0) {
  if (mod.fns.has(name)) return project.fnOf.get(mod.fns.get(name))
  const imp = mod.imports.get(name)
  if (!imp || seen > 4) return null
  const target = project.mods.get(imp.from) || project.mods.get(imp.from + '.js')
  if (!target) return null
  return resolve(project, target, target.exports.get(imp.name) ?? imp.name, seen + 1)
}

// ---------- hot set ----------

function hotSet(project) {
  const via = new Map()      // hot function -> the hot function that reaches it (null for roots)
  const queue = []
  const mark = (f, from) => { if (f && !via.has(f)) { via.set(f, from); queue.push(f) } }
  for (const { mod, arg } of project.rootRefs) mark(isFn(arg) ? project.fnOf.get(arg) : arg.type === 'Identifier' ? resolve(project, mod, arg.name) : null, null)
  while (queue.length) {
    const f = queue.shift()
    for (const a of f.iter) mark(project.fnOf.get(a), f)
    for (const c of f.calls) {
      if (!c.member) { mark(resolve(project, f.mod, c.name), f); continue }
      const cands = project.methods.get(c.name)
      if (cands && cands.length <= 4) for (const m of cands) mark(m, f)
    }
  }
  return via
}

// Root > ... > f, the root and f with their file names.
const chainOf = (via, f) => { const c = []; for (let g = f; g && c.length < 40; g = via.get(g)) c.unshift(g); return c }
const chain = (via, f) => {
  const c = chainOf(via, f), shown = c.length > 6 ? [c[0], ...c.slice(-5)] : c
  return shown.map((g, i) => (i === 0 || g === f ? `${g.name} (${path.basename(g.mod.rel)})` : g.name)).join(' > ').replace(/^(.*?\)) > /, c.length > 6 ? '$1 > ... > ' : '$1 > ')
}

// A chain through a one-off action (a purchase, a kill, a throw, a lazy build) runs on events, not every frame.
const EVENT = /^(on[A-Z_]|handle|use|buy|cook|throw|launch|place|spawn|kill|explode|blast|detonate|impact|collect|drop|start|end|open|give|apply|raise|show|build|ensure|init|create|make|setup|equip|reload|fire|shoot|trigger|award|grant|unlock|toggle|enter|exit|begin|finish|reset)/i
const eventIn = c => c.find(g => EVENT.test(g.name.split('.').pop()))

// ---------- rules ----------

// Findings in one hot function's own body (nested functions are checked on their own if they are hot).
// Inside `if (!x)`, `x ?? ...`, `x || ...` or `x ??= ...`: a lazy one-time build, not per-frame work.
const lazy = stack => stack.some(a =>
  (a.type === 'IfStatement' && ((a.test.type === 'UnaryExpression' && a.test.operator === '!') || /null|undefined/.test(a.test.right?.raw ?? a.test.right?.name ?? ''))) ||
  (a.type === 'LogicalExpression' && a.operator !== '&&') || (a.type === 'AssignmentExpression' && /\?\?=|\|\|=/.test(a.operator)))

function check(f, report) {
  const stack = []
  const scan = node => {
    if (node !== f.node && isFn(node)) return
    if (node.type === 'NewExpression' && !lazy(stack)) {
      const n = nameOf(node.callee)
      if (n && MATH.test(n)) report(node, 'alloc-math', `new ${n}()`)
      else if (n && GPU.test(n)) report(node, 'gpu-object', `new ${n}()`)
      else if (/^(Float32|Float64|Uint8|Uint16|Uint32|Int8|Int16|Int32)Array$|^Array$/.test(n)) report(node, 'alloc-typed', `new ${n}()`)
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const n = nameOf(node.callee), obj = node.callee.object
      if (n === 'clone') report(node, 'alloc-clone', `${short(f, obj)}.clone()`)
      else if (n === 'traverse' || n === 'traverseVisible') report(node, 'traverse', `${short(f, obj)}.${n}()`)
      else if (LAYOUT.has(n)) report(node, 'layout-read', `${n}()`)
      else if (ALLOC_ARRAY.has(n)) report(node, 'alloc-array', `.${n}()`)
      else if (obj.type === 'Identifier' && obj.name === 'JSON') report(node, 'json', `JSON.${n}()`)
      else if (obj.type === 'Identifier' && obj.name === 'Object' && /^(keys|values|entries)$/.test(n)) report(node, 'alloc-array', `Object.${n}()`)
    }
    if (node.type === 'MemberExpression' && !node.computed && LAYOUT.has(node.property.name) && !/^(getBoundingClientRect|getComputedStyle)$/.test(node.property.name)) report(node, 'layout-read', node.property.name)
    if (node.type === 'SpreadElement' && f) report(node, 'alloc-array', '[...spread]')
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      const p = nameOf(node.left), target = short(f, node.left.object)
      const last = target.split('.').pop()
      if (p === 'needsUpdate' && /material|^mats?|^mat[A-Z0-9_]|Mat$|Mat\[/.test(last) && !/matrix/i.test(last)) report(node, 'material-update', `${target}.needsUpdate = ...`)
      if (p === 'innerHTML') report(node, 'dom-write', 'innerHTML = ...')
    }
    stack.push(node)
    children(node, scan)
    stack.pop()
  }
  scan(f.node)
}

// Anywhere in a file, hot or not: transparent + DoubleSide without forceSinglePass in one object literal, and under
// WebGPURenderer, attributes set to DynamicDrawUsage (it re-uploads those on every draw, changed or not).
function checkAnywhere(mod, report, webgpu) {
  const scan = node => {
    if (node.type === 'ObjectExpression') {
      const props = new Map(node.properties.filter(p => p.key).map(p => [p.key.name ?? p.key.value, p.value]))
      const t = props.get('transparent'), s = props.get('side')
      if (t?.value === true && s && /DoubleSide/.test(nameOf(s) ?? '') && !props.has('forceSinglePass')) report(node, 'double-pass', 'transparent + DoubleSide')
    }
    if (webgpu && node.type === 'CallExpression' && nameOf(node.callee) === 'setUsage' && nameOf(node.arguments[0]) === 'DynamicDrawUsage')
      report(node, 'dynamic-usage', 'setUsage(DynamicDrawUsage)')
    children(node, scan)
  }
  scan(mod.ast)
}

const short = (f, node) => f.mod.src[node.loc.start.line - 1].slice(node.loc.start.column, node.loc.end.column).replace(/\s+/g, ' ').slice(0, 40)

// ---------- command ----------

export async function lint(dir, cfg, paths, flags) {
  const project = { mods: new Map(), fnOf: new Map(), methods: new Map(), rootRefs: [], classStack: [], errors: [],
    rootNames: new Set(cfg.roots || ['requestAnimationFrame', 'setAnimationLoop']) }
  const list = files(dir, paths.length ? paths : cfg.include || ['.'])
  for (const file of list) indexFile(file, path.relative(dir, file).replace(/\\/g, '/'), project)
  const via = hotSet(project)

  const runtime = measured(dir)
  const found = [], seen = new Set()
  const add = (mod, f) => (node, rule, what) => {
    const line = node.loc.start.line, key = `${mod.rel}:${line}:${rule}`
    const near = (mod.src[line - 1] || '') + (mod.src[line - 2] || '')
    if (seen.has(key) || /kit-ignore(?!\s+[\w-])/.test(near) || near.includes(`kit-ignore ${rule}`)) return
    seen.add(key)
    // per-frame findings keep their severity; on an event path GPU builds are hitch risks and the rest is info
    const ev = f && eventIn(chainOf(via, f))
    const sev = !ev ? RULES[rule][0] : rule === 'gpu-object' ? 'hitch' : 'info'
    const ran = f && runtime.fns.get(`${mod.rel}:${f.node.loc.start.line}`)
    found.push({ file: mod.rel, line, rule, sev, what, hot: f && chain(via, f), event: ev?.name, ran })
  }
  for (const f of via.keys()) check(f, add(f.mod, f))
  const webgpu = [...project.mods.values()].some(m => m.src.some(l => l.includes('WebGPURenderer')))
  for (const mod of project.mods.values()) checkAnywhere(mod, add(mod, null), webgpu)

  // report: measured findings first, then static per-frame ones, then event-time GPU builds (hitch risks)
  const max = +(flags.max || 40), out = [], used = new Set()
  const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  const byCost = (a, b) => (b.ran.kb || 0) - (a.ran.kb || 0) || (b.ran.ms || 0) - (a.ran.ms || 0)
  const section = (title, items, why, order = byPlace) => {
    if (!items.length) return
    out.push('', `${title} (${items.length})`)
    let last = ''
    for (const x of items.sort(order).slice(0, max)) {
      used.add(x.rule)
      const tail = `${x.rule.padEnd(15)}  ${x.what}${x.hot ? `   [${why(x)}]` : ''}`
      if (order !== byPlace) { out.push(`  ${`${x.file}:${x.line}`.padEnd(34)}  ${tail}`); continue }
      if (x.file !== last) { out.push(`  ${x.file}`); last = x.file }
      out.push(`    ${String(x.line).padStart(4)}  ${tail}`)
    }
    if (items.length > max) out.push(`    ... ${items.length - max} more (--max n)`)
  }
  const cost = r => [r.kb && `${r.kb} KB`, r.ms && `${r.ms} ms`].filter(Boolean).join(', ')
  out.push(`kit lint: ${list.length} files, ${via.size} functions reachable from per-frame entry points (${[...project.rootNames].join(', ')})`)
  out.push(runtime.from.length ? `runtime: functions seen running in ${runtime.from.join(', ')} (.kit/*.last.json)` : 'runtime: no kit perf results yet; run kit perf <scenario> to rank findings by what really runs')
  const ran = found.filter(x => x.ran && x.sev !== 'hitch')
  section('measured: these ran in a perf scenario, per frame, costliest first', ran, x => `${cost(x.ran)} per frame in ${x.ran.scenario}: ${x.hot}`, byCost)
  section('reachable from per-frame code (static; may only run on events)', found.filter(x => x.sev === 'warn' && !x.ran), x => x.hot ?? 'any code')
  section('on events: builds GPU objects mid-game, a hitch risk (prewarm or pool them)', found.filter(x => x.sev === 'hitch'), x => `on ${x.event}: ${x.hot}`)
  if (flags.all) section('info', found.filter(x => x.sev === 'info' && !x.ran), x => (x.event ? `on ${x.event}: ` : 'per frame: ') + x.hot)
  if (used.size) out.push('', 'rules:', ...Object.keys(RULES).filter(r => used.has(r)).map(r => `  ${r.padEnd(15)}  ${RULES[r][1]}`))
  const count = sev => found.filter(x => x.sev === sev && !x.ran).length
  const info = Object.entries(found.filter(x => x.sev === 'info' && !x.ran).reduce((o, x) => (o[x.rule] = (o[x.rule] || 0) + 1, o), {}))
  out.push('', `summary: ${ran.length} measured, ${count('warn')} static per-frame, ${count('hitch')} hitch risks, info: ${info.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${flags.all ? '' : ' (--all lists info)'}`)
  if (project.errors.length) out.push(...project.errors)
  console.log(out.join('\n'))
  return { failed: flags.strict ? ran.length + count('warn') > 0 : false, found }
}

// Project functions kit perf saw running ("fn file:line" -> per-frame ms / KB), merged over every saved last run.
function measured(dir) {
  const fns = new Map(), from = []
  const kit = path.join(dir, '.kit')
  if (!fs.existsSync(kit)) return { fns, from }
  for (const f of fs.readdirSync(kit).filter(f => f.endsWith('.last.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(kit, f), 'utf8'))
    if (!r.functions) continue
    from.push(r.meta.scenario)
    for (const [k, v] of Object.entries(r.functions)) {
      const m = k.match(/ (\S+):(\d+)$/)
      if (!m) continue
      const key = `${m[1]}:${m[2]}`, old = fns.get(key)
      if (!old || (v.kb || 0) + (v.ms || 0) > (old.kb || 0) + (old.ms || 0)) fns.set(key, { ...v, scenario: r.meta.scenario })
    }
  }
  return { fns, from }
}

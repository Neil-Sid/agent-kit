// CPU and allocation profiles over Chrome DevTools Protocol, folded into "function file:line" rows an agent can act on.
import path from 'node:path'

// Run fn while the V8 sampling profilers record. Returns { cpu, alloc, ms } rows keyed by function location, plus
// cpuUnder / allocUnder: library cost by the project function it ran under.
export async function profile(page, root, fn) {
  const cdp = await page.createCDPSession()
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  await cdp.send('HeapProfiler.enable')
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
  await cdp.send('Profiler.start')
  const t = Date.now()
  await fn()
  const ms = Date.now() - t
  const { profile: cpu } = await cdp.send('Profiler.stop')
  const { profile: heap } = await cdp.send('HeapProfiler.stopSampling')
  await cdp.detach()
  // the heap profile names the probe's script by id only; the CPU profile has its sourceURL too
  const probe = new Set(cpu.nodes.filter(n => n.callFrame.url.endsWith('kit-probe.js')).map(n => n.callFrame.scriptId))
  const c = foldCpu(cpu, probe), a = foldHeap(heap, probe)
  return { cpu: c.rows, alloc: a.rows, cpuUnder: c.under, allocUnder: a.under, ms }
}

// "fn file:line" for a call frame; page URLs are shortened to project paths, CDN ones to their file name.
// Library code (CDN, node_modules, vendor folders, native) is prefixed "lib " so reports can split it out.
const LOCAL = /^https?:\/\/127\.0\.0\.1:\d+\//
function where(cf, probe) {
  if (probe.has(cf.scriptId)) return PROBE
  if (!cf.url) return cf.functionName?.startsWith('(') ? cf.functionName : `lib ${cf.functionName || '(native)'}`
  const local = LOCAL.test(cf.url) && !/node_modules|\/vendor\/|\/libs?\//.test(cf.url)
  const file = local ? cf.url.replace(LOCAL, '') : path.basename(cf.url.split('?')[0])
  return `${local ? '' : 'lib '}${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`
}
const isLib = k => k.startsWith('lib ')
const isMine = k => !isLib(k) && !/^\(.*\)$/.test(k)
const PROBE = '(kit probe)'
export const NONE = '(none of your functions above it)'
// The owner of a frame: the nearest project function at or above it; failing that the probe (its share isn't
// reported) when the probe is above it, else NONE.
const ownerBelow = (k, above) => isMine(k) ? k : k === PROBE && above === NONE ? PROBE : above

// Library cost goes to the nearest project function up the stack: "updateMatrixWorld ran under animate main.js:80".
const charge = (under, mine, lib, v) => {
  const libs = under.get(mine) ?? under.set(mine, new Map()).get(mine)
  libs.set(lib, (libs.get(lib) || 0) + v)
}

// Self time per function in ms. (garbage collector), (program) and (idle) are kept: they say where else time went.
function foldCpu(p, probe) {
  const total = (p.endTime - p.startTime) / 1000, hits = p.samples.length || 1
  const rows = new Map(), under = new Map()
  const parent = new Map(), byId = new Map(p.nodes.map(n => [n.id, n])), owner = new Map()
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
  const ownerOf = id => {
    const path = []
    let i = id
    for (; i !== undefined && !owner.has(i); i = parent.get(i)) path.push(i)
    let above = i === undefined ? NONE : owner.get(i)
    for (const j of path.reverse()) owner.set(j, above = ownerBelow(where(byId.get(j).callFrame, probe), above))
    return owner.get(id)
  }
  for (const n of p.nodes) {
    if (!n.hitCount) continue
    const k = where(n.callFrame, probe), ms = n.hitCount / hits * total
    rows.set(k, (rows.get(k) || 0) + ms)
    if (isLib(k)) charge(under, ownerOf(n.id), k, ms)
  }
  return { rows, under }
}

// Bytes allocated per function (including objects already collected again: that churn is what drives GC).
function foldHeap(p, probe) {
  const rows = new Map(), under = new Map()
  const walk = (n, mine) => {
    const k = where(n.callFrame, probe)
    mine = ownerBelow(k, mine)
    if (n.selfSize) {
      rows.set(k, (rows.get(k) || 0) + n.selfSize)
      if (isLib(k)) charge(under, mine, k, n.selfSize)
    }
    n.children.forEach(c => walk(c, mine))
  }
  walk(p.head, NONE)
  return { rows, under }
}

// The n biggest rows, scaled by k (e.g. per frame).
export const top = (rows, n, k = 1) => [...rows].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, v]) => [name, v * k])

// The n project functions with the most library cost under them: [[fn, total, [[lib fn, v], ...]], ...], scaled by k.
export const topUnder = (under, n, k = 1) => [...under].filter(([fn]) => fn !== PROBE).map(([fn, libs]) => [fn, [...libs.values()].reduce((a, b) => a + b, 0), libs])
  .sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, sum, libs]) => [fn, sum * k, top(libs, 3, k)])

// CPU and allocation profiles over Chrome DevTools Protocol, folded into "function file:line" rows an agent can act on.
import path from 'node:path'

// Run fn while the V8 sampling profilers record. Returns { cpu, alloc, ms } rows keyed by function location.
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
  return { cpu: foldCpu(cpu, root), alloc: foldHeap(heap, root), ms }
}

// "fn file:line" for a call frame; page URLs are shortened to project paths, CDN ones to their file name.
// Library code (CDN, node_modules, vendor folders, native) is prefixed "lib " so reports can split it out.
const LOCAL = /^https?:\/\/127\.0\.0\.1:\d+\//
function where(cf) {
  if (!cf.url) return cf.functionName?.startsWith('(') ? cf.functionName : `lib ${cf.functionName || '(native)'}`
  const local = LOCAL.test(cf.url) && !/node_modules|\/vendor\/|\/libs?\//.test(cf.url)
  const file = local ? cf.url.replace(LOCAL, '') : path.basename(cf.url.split('?')[0])
  return `${local ? '' : 'lib '}${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`
}

// Self time per function in ms. (garbage collector), (program) and (idle) are kept: they say where else time went.
function foldCpu(p, root) {
  const total = (p.endTime - p.startTime) / 1000, hits = p.samples.length || 1
  const rows = new Map()
  for (const n of p.nodes) {
    if (!n.hitCount) continue
    const k = where(n.callFrame)
    rows.set(k, (rows.get(k) || 0) + n.hitCount / hits * total)
  }
  return rows
}

// Bytes allocated per function (including objects already collected again: that churn is what drives GC).
function foldHeap(p, root) {
  const rows = new Map()
  const walk = n => {
    if (n.selfSize) { const k = where(n.callFrame); rows.set(k, (rows.get(k) || 0) + n.selfSize) }
    n.children.forEach(walk)
  }
  walk(p.head)
  return rows
}

// The n biggest rows, scaled by k (e.g. per frame).
export const top = (rows, n, k = 1) => [...rows].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, v]) => [name, v * k])

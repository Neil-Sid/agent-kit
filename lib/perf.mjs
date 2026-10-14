// kit perf: run a scenario on the real GPU, print one text report, check budgets, diff against the saved baseline.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { serve, launch, open } from './browser.mjs'
import { probe } from './probe.js'
import { profile, top, topUnder } from './profile.mjs'

const pct = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * f))] ?? 0 }
const avg = arr => arr.reduce((a, b) => a + b, 0) / (arr.length || 1)
const r1 = v => Math.round(v * 10) / 10

// Open the project in a fresh browser, ready and set up for a scenario. Shared with replay, ab and net.
// site: a subfolder to serve instead of the project root (a build output such as dist/; config.serve sets it for every
// command); onPage(page) runs before load.
export async function start(dir, config, { scenario, freezeAtReady = false, headed = false, size, mode, traceRandom = false, site, onPage, realHost, inject } = {}) {
  const [width, height] = (size || config.size || '1920x1080').split('x').map(Number)
  site ??= config.serve
  const server = await serve(site ? path.join(dir, site) : dir, { realHost })
  const browser = await launch({ width, height, headed })
  const src = f => f && String(f)
  const opts = { ready: src(config.ready), renderer: src(config.renderer), state: src(config.state), scenes: src(config.scenes), freezeAtReady, mode, traceRandom, epoch: config.epoch }
  const url = `http://127.0.0.1:${server.address().port}/${config.query || ''}`
  const { page, errors } = await open(browser, url, { probe, arg: opts, ready: () => window.__kit?.ready, onPage }).catch(async e => {
    await browser.close(); server.close(); throw e
  })
  await page.evaluate(() => __kit.seed(1))
  if (inject) await page.evaluate(inject)              // runs before setup, e.g. kit render's optimizer
  if (scenario?.setup) await page.evaluate(`(${scenario.setup})()`)
  const close = async () => { await browser.close(); server.close() }
  return { page, errors, close, width, height }
}

export async function perf(dir, config, name, flags) {
  const result = await measure(dir, config, name, flags)
  report(dir, result, config.budgets || {}, flags)
  return result
}

// Run a scenario and return its result without printing (perf prints it; ab compares two).
export async function measure(dir, config, name, flags) {
  if (!config.scenarios?.[name]) throw new Error(`no scenario "${name}" in kit.config.mjs (have: ${Object.keys(config.scenarios || {}).join(', ')})`)
  const scenario = { ...config.scenarios[name], name }
  // windows are counted in frames, so every run simulates exactly the same frames (the clock is fixed at 1/60 s);
  // --runs n replays them in n fresh pages and keeps the median: other load on the machine moves single runs a lot
  const frames = +(flags.frames || scenario.frames || 600), runs = +(flags.runs || config.runs || 1)
  const extra = []
  for (let i = 1; i < runs; i++) extra.push((await session(dir, config, scenario, frames, flags, false)).window)
  const s = await session(dir, config, scenario, frames, flags, true)
  const result = summarize([s.window, ...extra], s.prof, s.systems, s.counts0, s.counts1, config)
  result.diag = s.diag
  result.state = s.stateJson && JSON.parse(s.stateJson)
  const state = s.stateJson && crypto.createHash('md5').update(s.stateJson).digest('hex').slice(0, 8)
  result.meta = { scenario: name, frames, runs, state, size: s.size, at: new Date().toISOString(), errors: [...new Set(s.errors)].slice(0, 10), driveError: s.driveError }
  result.shots = s.shots
  if (flags.hitches) result.hitches = await hitches(dir, config, scenario, s, flags)
  return result
}

// The worst frames of the timed window, each re-run in a fresh page (the scenario replays the same frames) with the
// profiler on for just the frames around it: what that hitch was made of.
async function hitches(dir, config, scenario, s, flags) {
  const warmup = +(scenario.warmup ?? 120), long = config.longMs || 1000 / 60
  // a long gap before frame i means frame i-1's work (or a stall it caused) ran long
  const worst = s.window.gap.map((g, i) => [warmup + i - 1, g]).filter(([, g]) => g > long)
    .sort((a, b) => b[1] - a[1]).slice(0, +(flags.hitches === true ? 3 : flags.hitches))
  const out = []
  for (const [f, gap] of worst) {
    const run = await start(dir, config, { scenario, size: flags.size, freezeAtReady: true, mode: scenario.realtime ? 'real' : 'fixed' })
    try {
      const { page } = run
      if (scenario.drive) await page.evaluate(`__kit.drive = (${scenario.drive})`)
      await page.evaluate(`__kit.go('fixed')`)
      await page.evaluate(`__kit.runTo(${Math.max(0, f - 1)})`)
      await page.evaluate(() => __kit.startMeasure(10))
      const prof = await profile(page, dir, () => page.evaluate(`__kit.runTo(${f + 2})`))
      const m = await page.evaluate(() => __kit.stopMeasure())
      const labels = await page.evaluate(() => __kit.labels)
      const label = labels.filter(([lf]) => lf <= f).at(-1)
      const skip = new Set(['(idle)', '(program)', '(root)'])
      const rows = top(new Map([...prof.cpu].filter(([k]) => !skip.has(k))), 8).map(([k, v]) => [k, Math.round(v * 10) / 10])
      out.push({ frame: f, gap: r1(gap), regap: r1(Math.max(...m.gap.slice(1), 0)), after: label && `${label[1]} at frame ${label[0]}`, rows })
    } finally { await run.close() }
  }
  return out
}

// One fresh page through the scenario: warm-up, a timed window, and (full) the scene diagnosis and profiles.
async function session(dir, config, scenario, frames, flags, full) {
  const clock = scenario.realtime ? 'real' : 'fixed'
  const run = await start(dir, config, { scenario, size: flags.size, freezeAtReady: true, mode: clock, site: flags.site, inject: flags.inject })
  const { page } = run
  try {
    if (scenario.drive) await page.evaluate(`__kit.drive = (${scenario.drive})`)
    await page.evaluate(`__kit.go('${clock}')`)
    const until = n => page.evaluate(`__kit.runTo(${n})`)
    let at = +(scenario.warmup ?? 120)
    await until(at)

    // timing pass: no profilers attached, so the frame gaps are honest
    const out = { size: `${run.width}x${run.height}`, errors: run.errors }
    out.counts0 = await page.evaluate(() => __kit.counts())
    if (config.systems) await page.evaluate(`(${config.systems})()`)
    // timed window; full sessions stop at each requested screenshot frame on the way (the gap after a stop is not counted)
    await page.evaluate(() => __kit.startMeasure())
    out.shots = []
    const end = at + frames
    for (const f of full ? (flags.shots || []).filter(f => f > at && f <= end).sort((a, b) => a - b) : []) {
      await until(f)
      const file = path.join(flags.shotDir || path.join(dir, '.kit', 'shots'), `${scenario.name || 'shot'}-${f}.png`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      await page.screenshot({ path: file })
      out.shots.push({ frame: f, file })
    }
    await until(at = end)
    out.window = await page.evaluate(() => __kit.stopMeasure())
    if (!full) return out
    out.systems = config.systems ? await page.evaluate(`(${config.systems})()`) : null
    // the game state after the window: equal across runs means the same frames were simulated
    out.stateJson = config.state && await page.evaluate(`JSON.stringify((${config.state})())`)
    out.counts1 = await page.evaluate(() => __kit.counts())
    if (config.scenes) {
      const d = page.evaluate(() => __kit.diagnose(30))
      await until(at += 30)
      out.diag = await d
    }
    // profiling pass: where the CPU time and the allocations go
    if (!flags['no-profile']) {
      await page.evaluate(() => __kit.startMeasure())
      out.prof = await profile(page, dir, () => until(at += Math.min(600, frames)))
      out.prof.frames = (await page.evaluate(() => __kit.stopMeasure())).n
    }
    out.driveError = await page.evaluate(() => __kit.driveError)
    return out
  } finally { await run.close() }
}

// Metrics of one measured window.
function windowMetrics(m, long) {
  const gaps = m.gap.slice(1)
  let drops = 0
  for (let i = 1; i < m.heap.length; i++) if (m.heap[i] < m.heap[i - 1] - 1e6) drops++
  return {
    frames: m.n, fps: Math.round(1000 / (avg(gaps) || 1)),
    p50: r1(pct(gaps, 0.5)), p95: r1(pct(gaps, 0.95)), p99: r1(pct(gaps, 0.99)), max: r1(Math.max(0, ...gaps)),
    long: gaps.filter(g => g > long).length,
    cpuP50: r1(pct(m.cpu, 0.5)), cpuP99: r1(pct(m.cpu, 0.99)),
    drawCalls: Math.round(avg(m.calls)), drawCallsMax: Math.max(0, ...m.calls), triangles: Math.round(avg(m.tris)),
    heapDrops: drops,
  }
}

function summarize(windows, prof, systems, c0, c1, config) {
  const all = windows.map(w => windowMetrics(w, config.longMs || 1000 / 60))
  const metrics = Object.fromEntries(Object.keys(all[0]).map(k => [k, pct(all.map(a => a[k]), 0.5)]))
  const out = {
    metrics,
    spread: all.length > 1 && Object.fromEntries(['fps', 'p99', 'max'].map(k => [k, all.map(a => a[k])])),
    growth: c0 && c1 && Object.fromEntries(Object.keys(c1).map(k => [k, c1[k] - c0[k]])),
    systems,
  }
  if (prof) {
    const perFrame = 1 / Math.max(1, prof.frames)
    out.metrics.allocKB = r1([...prof.alloc.values()].reduce((a, b) => a + b, 0) / 1024 * perFrame)
    out.metrics.gcMs = Math.round((prof.cpu.get('(garbage collector)') || 0) * perFrame * 100) / 100
    // V8's own rows such as (program), (garbage collector) or (IDLE_EXTERNAL) have no file and belong to neither list
    const split = (rows, lib) => new Map([...rows].filter(([k]) => !/^\(.*\)$/.test(k) && k.startsWith('lib ') === lib))
    const ms = rows => rows.map(([k, v]) => [k, Math.round(v * 100) / 100]), kb = rows => rows.map(([k, v]) => [k, r1(v)])
    out.cpu = ms(top(split(prof.cpu, false), 8, perFrame))
    out.cpuLib = ms(top(split(prof.cpu, true), 4, perFrame))
    out.alloc = kb(top(split(prof.alloc, false), 6, perFrame / 1024))
    out.allocLib = kb(top(split(prof.alloc, true), 3, perFrame / 1024))
    // library cost by the project function it ran under, with the three biggest library functions in each
    const under = (rows, round) => rows.map(([k, v, libs]) => [k, round(v), libs.map(([l, x]) => [l, round(x)]).filter(([, x]) => x > 0)]).filter(([, v]) => v > 0)
    out.cpuUnder = under(topUnder(prof.cpuUnder, 5, perFrame), v => Math.round(v * 100) / 100)
    out.allocUnder = under(topUnder(prof.allocUnder, 4, perFrame / 1024), r1)
    // every project function seen running, for kit lint to confirm which of its findings really run: "fn file:line"
    out.functions = {}
    for (const [k, v] of split(prof.cpu, false)) out.functions[k] = { ms: Math.round(v * perFrame * 1000) / 1000 }
    for (const [k, v] of split(prof.alloc, false)) (out.functions[k] ??= {}).kb = r1(v * perFrame / 1024)
    for (const [k, libs] of prof.cpuUnder) if (!k.startsWith('(')) (out.functions[k] ??= {}).lib = Math.round([...libs.values()].reduce((a, b) => a + b, 0) * perFrame * 1000) / 1000
  }
  return out
}

// ---------- report ----------

function report(dir, res, budgets, flags) {
  const { metrics: m, meta } = res, out = []
  const base = baselineOf(dir, meta.scenario)
  const delta = k => {
    const b = base?.metrics[k]
    if (b === undefined || m[k] === undefined) return ''
    const d = r1(m[k] - b)
    return d ? ` (${d > 0 ? '+' : ''}${d})` : ''
  }
  const f = (k, name = k) => `${name} ${m[k]}${delta(k)}`

  const runs = meta.runs > 1 ? `${meta.frames} frames, median of ${meta.runs} runs` : `${meta.frames} frames`
  const same = base?.meta.state && meta.state ? (base.meta.state === meta.state ? ' (same as baseline)' : ' (baseline differs)') : ''
  out.push(`kit perf "${meta.scenario}"  ${meta.size}  ${runs}  state #${meta.state}${same}${base ? '  (+/- vs baseline)' : ''}`)
  out.push(`frame  ${f('fps')} fps  ${f('p50')}  ${f('p95')}  ${f('p99')}  ${f('max')} ms  long ${m.long}${delta('long')}` +
    (res.spread ? `   runs: fps ${res.spread.fps.join('/')}  p99 ${res.spread.p99.join('/')}` : ''))
  out.push(`js     ${f('cpuP50', 'p50')}  ${f('cpuP99', 'p99')} ms per frame` + (m.gcMs !== undefined ? `   ${f('gcMs', 'gc')} ms/frame  ${f('allocKB', 'alloc')} KB/frame  heap drops ${m.heapDrops}` : ''))
  out.push(`gpu    ${f('drawCalls', 'draw calls')} (max ${m.drawCallsMax})  ${f('triangles', 'triangles')}`)
  if (res.systems) out.push(`split  ${Object.entries(res.systems).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')}  (ms/frame)`)
  const grew = res.growth && Object.entries(res.growth).filter(([, v]) => v > 0)
  if (grew?.length) out.push(`leak?  grew during the run: ${grew.map(([k, v]) => `${k} +${v}`).join(', ')}`)
  if (res.diag) {
    const c = res.diag.census, ch = res.diag.churn
    out.push(`scene  ${c.objects} objects  ${c.visibleMeshes}/${c.meshes} meshes visible (${c.instanced} instanced, ${c.transparent} transparent)  ${c.lights} lights (${c.shadowLights} shadow)  ${c.materials} materials  ${c.programs} programs`)
    const why = { version: 'needsUpdate / version bump', lights: 'lights state changed', colorSpace: 'output colour space flips' }
    const up = res.diag.uploads || []
    if (up.length) out.push(`upload ${Math.round(up.reduce((n, u) => n + u.kb, 0))} KB/frame re-sent to the GPU: ${up.slice(0, 4).map(u => `${u.name} ${u.kb} KB`).join('; ')}`)
    const w = res.diag.writes || []
    if (w.length) out.push(`queue  writeBuffer per frame: ${w.reduce((n, x) => n + x.calls, 0)} calls, ${w.reduce((n, x) => n + x.kb, 0)} KB, ${w.reduce((n, x) => n + x.ms, 0).toFixed(1)} ms`,
      ...w.map(x => `  ${String(x.ms).padStart(6)} ms  ${String(x.calls).padStart(5)} calls  ${String(x.kb).padStart(6)} KB  ${x.site}`))
    for (const k in ch) if (ch[k].length) out.push(`churn  ${ch[k].length} materials re-pick their shader every frame: ${why[k]}  e.g. ${[...new Set(ch[k])].slice(0, 4).join('; ')}`)
  }
  const rows = (title, list) => list?.length && out.push(title, ...list.map(([k, v]) => `  ${String(v).padStart(6)}  ${k}`))
  for (const h of res.hitches || []) {
    out.push(`hitch  frame ${h.frame}: ${h.gap} ms (${h.regap} ms when re-run)${h.after ? `, after "${h.after}"` : ''}; self ms in those frames:`)
    out.push(...h.rows.map(([k, v]) => `  ${String(v).padStart(6)}  ${k}`))
  }
  // "lib updateMatrixWorld three.module.js:8123" -> "updateMatrixWorld"; anonymous ones keep their file
  const libName = k => k.replace(/^lib /, '').replace(/^(?!\(anon\))(\S+) \S+$/, '$1')
  const under = (title, list) => list?.length && out.push(title,
    ...list.map(([k, v, libs]) => `  ${String(v).padStart(6)}  ${k}   ${libs.map(([l, x]) => `${libName(l)} ${x}`).join(', ')}`))
  rows('top cpu, project (self ms/frame)', res.cpu)
  rows('top cpu, libraries', res.cpuLib)
  under('library cpu under your functions (ms/frame, biggest library functions in each)', res.cpuUnder)
  rows('top alloc, project (KB/frame)', res.alloc)
  rows('top alloc, libraries', res.allocLib)
  under('library alloc under your functions (KB/frame)', res.allocUnder)

  const fails = budgetFails(res, budgets)
  out.push(fails.length ? `BUDGET FAIL  ${fails.join('  |  ')}` : `budgets ok (${Object.keys(budgets).length})`)
  if (meta.errors.length) out.push(`console errors: ${meta.errors.join(' | ').slice(0, 400)}`)
  if (meta.driveError) out.push(`drive error: ${meta.driveError}`)

  saveResult(dir, res, flags.save)
  if (flags.save) out.push(`saved as baseline: .kit/${meta.scenario}.baseline.json`)
  console.log(out.join('\n'))
  res.failed = fails.length > 0 || meta.errors.some(e => e.startsWith('[pageerror]'))
}

// Budgets: a number is a ceiling, { min } a floor. Names are metrics, or resources that grew during the run.
export function budgetFails(res, budgets) {
  const fails = []
  for (const [k, lim] of Object.entries(budgets)) {
    const v = res.metrics[k] ?? res.growth?.[k]
    if (v === undefined) continue
    if (typeof lim === 'object' ? v < lim.min : v > lim) fails.push(`${k} ${v} ${typeof lim === 'object' ? `< ${lim.min}` : `> ${lim}`}`)
  }
  return fails
}

export const baselineOf = (dir, name) => {
  const f = path.join(dir, '.kit', `${name}.baseline.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

// .kit/<scenario>.last.json (kit lint reads the functions in it), and the baseline when asked.
export function saveResult(dir, res, asBaseline) {
  const kitDir = path.join(dir, '.kit')
  fs.mkdirSync(kitDir, { recursive: true })
  fs.writeFileSync(path.join(kitDir, `${res.meta.scenario}.last.json`), JSON.stringify(res, null, 1))
  if (asBaseline) fs.writeFileSync(path.join(kitDir, `${res.meta.scenario}.baseline.json`), JSON.stringify(res, null, 1))
}

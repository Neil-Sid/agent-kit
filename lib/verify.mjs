// kit verify: did my change keep the game the same, and is it faster? The scenarios run on a reference and on the
// working tree:
//   behavior  config.state() compared every 60 frames (the first difference is named), screenshots of the same frames
//             diffed pixel by pixel, and console errors only the new side has. The reference runs twice: whatever
//             differs between two runs of the same code (state or pixels) is the app's own noise and doesn't count.
//   speed     fresh pages alternating between the two sides (--runs, default 3 each). A change only counts when the
//             two sides' ranges don't overlap; otherwise it is within noise.
// The reference is a git commit (--ref, default HEAD) or another folder (--ref ../original). kit render runs the same
// comparison on one folder, without and with its optimizer.
//
//   kit verify <scenario...> [--ref HEAD|<folder>] [--runs 3] [--every 60] [--shots f1,f2]
import fs from 'node:fs'
import path from 'node:path'
import { start, measure } from './perf.mjs'
import { diffTriples } from './pixels.mjs'
import { git, snapshot } from './ab.mjs'

const SPEED = [['cpuP50', 'js ms/frame p50'], ['p50', 'frame ms p50'], ['p99', 'frame ms p99'], ['fps', 'fps', true], ['drawCalls', 'draw calls']]
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1]
const short = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : JSON.stringify(v)?.slice(0, 60))

// Where two state snapshots first differ; numbers within 1e-6 (relative) count as equal.
function firstDiff(a, b, at = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a)) ? { path: at, a, b } : null
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], at ? `${at}.${k}` : k); if (d) return d }
    return null
  }
  return a === b ? null : { path: at, a, b }
}

// One fresh page through the scenario, stopping at checkpoints for the state and at the screenshot frames.
async function behavior(config, name, side, flags, outDir) {
  const sc = { ...config.scenarios[name], name }
  const warm = +(sc.warmup ?? 120), end = warm + +(flags.frames || sc.frames || 600), every = +(flags.every || 60)
  const shots = flags.shots ? String(flags.shots).split(',').map(Number) : [warm, Math.round((warm + end) / 2), end]
  const stops = new Set(shots)
  if (config.state) for (let f = every; f <= end; f += every) stops.add(f)
  const run = await start(side.dir, config, { scenario: sc, freezeAtReady: true, mode: 'fixed', size: flags.size, inject: side.inject })
  const { page } = run, out = { states: [], shots: [], errors: run.errors }
  try {
    if (sc.drive) await page.evaluate(`__kit.drive = (${sc.drive})`)
    await page.evaluate(`__kit.go('fixed')`)
    for (const f of [...stops].sort((a, b) => a - b)) {
      await page.evaluate(`__kit.runTo(${f})`)
      if (config.state && f % every === 0) out.states.push([f, JSON.parse(await page.evaluate(`JSON.stringify((${config.state})())`))])
      if (shots.includes(f)) {
        const file = path.join(outDir, side.label, `${name}-${f}.png`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        await page.screenshot({ path: file })
        out.shots.push({ frame: f, file })
      }
    }
    if (side.collect) out.extra = JSON.parse(await page.evaluate(side.collect))
    return out
  } finally { await run.close() }
}

// Both sides through one scenario: behavior first, then the alternating speed runs.
export async function compare(config, name, sides, flags, outDir) {
  if (!config.scenarios?.[name]) throw new Error(`no scenario "${name}" in kit.config.mjs (have: ${Object.keys(config.scenarios || {}).join(', ')})`)
  const [A, B] = sides, lines = [`"${name}"`]
  const ba = await behavior(config, name, A, flags, outDir)
  const again = await behavior(config, name, { ...A, label: `${A.label}-again` }, flags, outDir)
  const bb = await behavior(config, name, B, flags, outDir)
  let same = true, unjudged = 0

  if (!config.state) lines.push('  state       no config.state(), so behavior is judged by screenshots only')
  else {
    const at = (x, y) => x.states.map(([f, s], i) => [f, firstDiff(s, y.states[i]?.[1])]).find(([, d]) => d)
    const noise = at(ba, again), hit = at(ba, bb), limit = noise ? noise[0] : Infinity
    if (hit && hit[0] < limit) { same = false; lines.push(`  state       DIFFERS from frame ${hit[0]}: ${hit[1].path || '(whole state)'} ${short(hit[1].a)} vs ${short(hit[1].b)}`) }
    else lines.push(`  state       identical at ${noise ? `every checkpoint before frame ${limit} (from there two runs of ${A.label} differ too)` : `all ${ba.states.length} checkpoints`}`)
  }
  const triples = ba.shots.map((s, i) => ({ frame: s.frame, a: s.file, a2: again.shots[i]?.file, b: bb.shots[i]?.file, diff: path.join(outDir, `${name}-${s.frame}-diff.png`) })).filter(p => p.a2 && p.b)
  for (const [i, d] of (await diffTriples(triples)).entries()) {
    // when most of the frame differs between two runs of the same code, a screenshot can't show a change
    const blind = d.noisePct > 25
    const verdict = blind ? "CAN'T JUDGE" : d.changedPct === 0 ? 'identical' : d.changedPct < 0.5 ? 'nearly identical' : 'VISIBLY DIFFERENT'
    if (blind) unjudged++
    else if (d.changedPct >= 0.5) same = false
    const noise = d.noisePct ? ` (ignoring the ${d.noisePct}% of the frame where two runs of ${A.label} differ)` : ''
    lines.push(`  frame ${String(triples[i].frame).padEnd(6)}${verdict}: ${d.changedPct}% of pixels changed${noise}  -> ${path.relative(process.cwd(), d.diff).replace(/\\/g, '/')}`)
  }
  const fresh = [...new Set(bb.errors)].filter(e => !ba.errors.includes(e))
  if (fresh.length) { same = false; lines.push(`  errors      new on ${B.label}: ${fresh.join(' | ').slice(0, 300)}`) }

  const runs = +(flags.runs || 3), vals = [[], []]
  for (let i = 0; i < runs; i++) for (const [k, s] of sides.entries())
    vals[k].push((await measure(s.dir, config, name, { ...flags, inject: s.inject, 'no-profile': true, runs: 1, shots: [] })).metrics)
  lines.push(`  speed       ${runs} fresh pages per side, alternating; median [range]`)
  const verdicts = {}
  for (const [k, label, higher] of SPEED) {
    const a = vals[0].map(m => m[k]), b = vals[1].map(m => m[k])
    if (a.some(v => v === undefined) || b.some(v => v === undefined)) continue
    const lo = x => Math.min(...x), hi = x => Math.max(...x)
    // one run per side has no range to compare, so it gets no verdict
    const better = runs > 1 && (higher ? lo(b) > hi(a) : hi(b) < lo(a)), worse = runs > 1 && (higher ? hi(b) < lo(a) : lo(b) > hi(a))
    verdicts[k] = better ? 'better' : worse ? 'worse' : 'noise'
    const pct = med(a) ? Math.round((med(b) - med(a)) / med(a) * 100) : 0
    const cell = x => `${med(x)} [${lo(x)}-${hi(x)}]`.padEnd(20)
    lines.push(`    ${label.padEnd(17)}${cell(a)}${cell(b)}${pct > 0 ? '+' : ''}${pct}%  ${better ? 'better' : worse ? 'WORSE' : runs > 1 ? 'within noise' : 'no verdict (1 run)'}`)
  }
  const faster = ['cpuP50', 'p50'].some(k => verdicts[k] === 'better') && !['cpuP50', 'p50'].some(k => verdicts[k] === 'worse')
  const slower = ['cpuP50', 'p50'].some(k => verdicts[k] === 'worse')
  const speed = faster ? 'FASTER' : slower ? 'SLOWER' : 'no measurable speed change'
  const seen = same && unjudged ? `SAME where it could be checked (${unjudged} frame(s) too noisy to judge)` : same ? 'SAME behavior' : 'BEHAVIOR CHANGED'
  lines.push(`  verdict     ${seen}, ${speed}`)
  return { lines, same, unjudged, faster, slower, extra: bb.extra }
}

export async function verify(dir, config, names, flags) {
  if (!names.length) throw new Error(`name scenarios to check (have: ${Object.keys(config.scenarios || {}).join(', ')})`)
  const ref = flags.ref || 'HEAD', asDir = path.resolve(dir, ref)
  let refDir, label
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) { refDir = asDir; label = path.basename(asDir) }
  else {
    try { label = git(dir, ['rev-parse', '--short', ref]) } catch { throw new Error(`"${ref}" is neither a folder nor a commit in ${dir}`) }
    refDir = snapshot(dir, label)
  }
  const outDir = path.join(dir, '.kit', 'verify')
  console.log(`kit verify: ${label} vs working tree`)
  let failed = false
  for (const name of names) {
    const r = await compare(config, name, [{ label, dir: refDir }, { label: 'now', dir }], flags, outDir)
    console.log(['', ...r.lines].join('\n'))
    failed ||= !r.same
  }
  return { failed }
}

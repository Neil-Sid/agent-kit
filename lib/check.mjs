// kit check: the one command to run before calling a change done. Each scenario runs once (as kit perf would) and gets
// a verdict line: budgets, page errors, and a ratchet against its saved baseline. The counters machine load doesn't
// move fail when they rise: draw calls, triangles, shader programs, allocation, and resources created during the run.
// Frame times only warn, since they move 10-30 % with load. Lint runs last, so its measured section uses these runs.
//
//   kit check [scenario...] [--save] [--strict] [--runs n]
//
// --save keeps this run's numbers as the new baselines (accepting any rise); a scenario without a baseline gets one.
// config.check.tolerance: { drawCalls: 0.05 } allows a bigger rise (a fraction of the baseline) for one counter.
import { measure, budgetFails, baselineOf, saveResult } from './perf.mjs'
import { lint } from './lint.mjs'

// [key, label, read(result), allowed rise as a fraction of the baseline, and at least this much]
const COUNTERS = [
  ['drawCalls', 'draw calls', r => r.metrics.drawCalls, 0.01, 1],
  ['triangles', 'triangles', r => r.metrics.triangles, 0.01, 1],
  ['programs', 'shader programs', r => r.diag?.census.programs, 0, 0],
  ['allocKB', 'alloc KB/frame', r => r.metrics.allocKB, 0.1, 2],     // sampled, so a little noise is allowed
  ...['geometries', 'textures', 'programs'].map(k => [`grew.${k}`, `${k} created during the run`, r => r.growth?.[k], 0, 0]),
]
// [key, label]: warn when 25 % and 0.5 ms worse
const TIMES = [['p99', 'frame p99 ms'], ['cpuP50', 'js p50 ms']]

const num = v => (v >= 1e4 ? `${Math.round(v / 100) / 10}k` : String(v))
const pct = (now, was) => (was ? ` (${now > was ? '+' : ''}${Math.round((now - was) / was * 100)}%)` : '')

export async function check(dir, config, names, flags) {
  names = names.length ? names : Object.keys(config.scenarios)
  const tolerance = config.check?.tolerance || {}, width = Math.max(...names.map(n => n.length))
  console.log(`kit check: ${names.join(', ')} against ${names.length > 1 ? 'their baselines' : 'its baseline'}, then lint`)
  const failed = [], better = []
  for (const name of names) {
    const res = await measure(dir, config, name, { runs: flags.runs, size: flags.size })
    const base = baselineOf(dir, name), m = res.metrics
    const fails = budgetFails(res, config.budgets || {}).map(f => `budget: ${f}`), warns = [], rose = [], fell = []
    const pageError = res.meta.errors.find(e => e.startsWith('[pageerror]'))
    if (pageError) fails.push(pageError.slice(0, 200))
    else if (res.meta.errors.length) warns.push(`console error: ${res.meta.errors[0].slice(0, 160)}`)
    if (res.meta.driveError) fails.push(`drive error: ${res.meta.driveError}`)
    if (base) {
      for (const [k, label, get, frac, min] of COUNTERS) {
        const now = get(res), was = get(base)
        if (now === undefined || was === undefined) continue
        const allowed = Math.max(min, was * (tolerance[k] ?? frac))
        if (now - was > allowed) rose.push(`${label} rose ${num(was)} -> ${num(now)}${pct(now, was)}`)
        else if (was - now > allowed) fell.push(`${label} ${num(was)} -> ${num(now)}`)
      }
      for (const [k, label] of TIMES) {
        const now = m[k], was = base.metrics[k]
        if (now > was * 1.25 && now - was > 0.5) warns.push(`${label} ${was} -> ${now}${pct(now, was)}: frame times move with machine load, kit perf ${name} --runs 3 to be sure`)
      }
    }
    if (flags.save) warns.push(...rose.map(x => `accepted: ${x}`))
    else fails.push(...rose)
    if (fell.length) better.push(`${name} (${fell.join(', ')})`)
    if (fails.length) failed.push(name)

    const status = fails.length ? 'FAIL' : warns.length ? 'warn' : base ? 'ok' : 'new'
    const programs = res.diag?.census.programs
    const line = [`draws ${m.drawCalls}`, `tris ${num(m.triangles)}`, programs !== undefined && `programs ${programs}`, m.allocKB !== undefined && `alloc ${m.allocKB} KB`, `p99 ${m.p99} ms`].filter(Boolean).join('  ')
    const note = !base ? '   (no baseline yet: saved this run as one)' : base.meta.state && res.meta.state !== base.meta.state ? '   (plays out differently from the baseline)' : ''
    console.log(`${status.padEnd(5)} ${name.padEnd(width)}  ${line}${note}`)
    for (const x of [...fails, ...warns]) console.log(`      ${' '.repeat(width)}  ${x}`)
    saveResult(dir, res, flags.save || !base)
  }

  const l = await lint(dir, config.lint || {}, [], { quiet: true })
  console.log(`lint  ${' '.repeat(width)}  ${l.measured} measured, ${l.warn} static per-frame, ${l.hitch} hitch risks${l.measured + l.warn + l.hitch ? ' (kit lint lists them)' : ''}`)
  if (flags.strict && l.measured + l.warn) failed.push('lint')
  if (better.length && !flags.save) console.log(`better than the baseline: ${better.join('; ')}. kit check --save keeps the new numbers`)
  console.log(failed.length ? `check FAILED: ${failed.join(', ')}` : `check ok${flags.save ? ', saved as the baselines' : ''}`)
  return { failed: failed.length > 0 }
}

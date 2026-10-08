// kit determinism: run a scenario twice side by side on the fixed clock and find the first checkpoint (every 30 frames)
// where the runs part: the random generator's state or the game state (config.state) differ. Then it finds the first
// Math.random call that went differently in that window - the code just before it depends on something outside the
// game clock (wall time, a ms budget, an async result).
import { start } from './perf.mjs'

const STEP = 30

// Run to `frames`, checkpointing; the page stays open so the diverging window's call order can be fetched after.
async function trace(dir, config, scenario, frames) {
  const run = await start(dir, config, { freezeAtReady: true, mode: 'fixed', traceRandom: true })
  const { page } = run
  const check = label => page.evaluate(`({ label: '${label}', rng: __kit.rng(), state: JSON.stringify((${config.state || '() => null'})()), sites: __kit.takeSites() })`)
  const windows = [await check('page load up to the ready frame')]
  await page.evaluate(() => __kit.seed(1))
  if (scenario.setup) await page.evaluate(`(${scenario.setup})()`)
  windows.push(await check('scenario setup'))
  if (scenario.drive) await page.evaluate(`__kit.drive = (${scenario.drive})`)
  await page.evaluate(() => __kit.go('fixed'))
  for (let f = STEP; f <= frames; f += STEP) {
    await page.evaluate(`__kit.runTo(${f})`)
    windows.push(await check(`frames ${f - STEP}-${f}`))
  }
  return { windows, run }
}

// First differing path of two JSON values.
function diff(a, b, at = '') {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = diff(a[k], b[k], at ? `${at}.${k}` : k); if (d) return d }
    return null
  }
  return a === b ? null : `${at}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`
}

export async function determinism(dir, config, name, flags) {
  const scenario = config.scenarios?.[name]
  if (!scenario) throw new Error(`no scenario "${name}"`)
  const frames = +(flags.frames || 900)
  const [a, b] = await Promise.all([trace(dir, config, scenario, frames), trace(dir, config, scenario, frames)])
  try {
    // the ready frame's random state may differ harmlessly (setup reseeds), so only its game state counts there
    const i = a.windows.findIndex((w, k) => (k > 0 && w.rng !== b.windows[k].rng) || w.state !== b.windows[k].state)
    if (i < 0) {
      console.log(`kit determinism "${name}": two runs identical for ${frames} frames (rng and state every ${STEP} frames)`)
      return { failed: false }
    }
    const wa = a.windows[i], wb = b.windows[i], out = []
    out.push(`kit determinism "${name}": runs part in ${wa.label}`)
    const sd = wa.state !== wb.state && diff(JSON.parse(wa.state), JSON.parse(wb.state))
    out.push(sd ? `state  ${sd}` : 'state  still equal here (only the random stream differs so far)')

    // walk both call orders to the first call that differs: everything after it is knock-on
    const [A, B] = await Promise.all([a, b].map(r => r.run.page.evaluate(`__kit.orders[${i}]`)))
    let k = 0
    while (k < A.length && k < B.length && A[k] === B[k]) k++
    if (k < A.length || k < B.length) {
      out.push(`first differing Math.random call (#${k} of the window):`)
      out.push(`  last shared:  ${A[k - 1] ?? '(window start)'}`)
      out.push(`  run A next:   ${A[k] ?? '(no more calls)'}`)
      out.push(`  run B next:   ${B[k] ?? '(no more calls)'}`)
      out.push('the code between "last shared" and the two "next" calls took a different path in each run: look there for')
      out.push('a wall-clock read (performance.now, Date.now, a ms budget), an async result, or a real-time callback')
    } else out.push('Math.random calls match in order: look for time read from performance.now(), Date.now(), audio or network callbacks')
    console.log(out.join('\n'))
    return { failed: true }
  } finally { await Promise.all([a.run.close(), b.run.close()]) }
}

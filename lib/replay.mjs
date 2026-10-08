// kit record / kit replay: capture a play session's input and frame times, then play it back headless so a bug or a
// hitch can be reproduced on demand. Replay checks the game state (config.state) against the recording every 30
// frames and reports the first frame it parts; until the game is deterministic (kit determinism) expect a drift.
//
//   kit record <name> [--scenario s]           visible window: play, press F8 to save .kit/<name>.replay.json
//   kit record <name> --script file.mjs        headless, input from the script's default export async (page) => {}
//   kit replay <name> [--perf] [--shot f1,f2]  headless; --perf prints frame times, --shot saves frames f1, f2...
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { start } from './perf.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const fileOf = (dir, name) => path.join(dir, '.kit', `${name}.replay.json`)

export async function record(dir, config, name, flags) {
  const scenario = flags.scenario ? config.scenarios?.[flags.scenario] : null
  const script = flags.script && (await import(pathToFileURL(path.resolve(dir, flags.script)))).default
  const run = await start(dir, config, { headed: !script, freezeAtReady: true, mode: 'fixed', size: flags.size })
  const { page } = run
  try {
    await page.evaluate(() => __kit.seed(1))
    if (scenario?.setup) await page.evaluate(`(${scenario.setup})()`)
    await page.evaluate(() => { __kit.startRecording(1); __kit.runTo(1e12) })    // not awaited: runs until stopped
    if (script) await script(page)
    else {
      console.log('recording: play in the window, press F8 to save (closing the window discards it)')
      while (!(await page.evaluate(() => __kit.recDone))) await sleep(300)
    }
    const data = await page.evaluate(() => __kit.stopRecording())
    data.meta = { scenario: flags.scenario || null, size: `${run.width}x${run.height}`, at: new Date().toISOString() }
    fs.mkdirSync(path.join(dir, '.kit'), { recursive: true })
    fs.writeFileSync(fileOf(dir, name), JSON.stringify(data))
    console.log(`kit record "${name}": ${data.dt.length} frames, ${data.events.length} input events, ${data.checks.length} state checks -> .kit/${name}.replay.json`)
  } finally { await run.close() }
}

export async function replay(dir, config, name, flags) {
  const file = fileOf(dir, name)
  if (!fs.existsSync(file)) throw new Error(`no recording .kit/${name}.replay.json (kit record ${name})`)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const scenario = data.meta.scenario ? config.scenarios?.[data.meta.scenario] : null
  const run = await start(dir, config, { freezeAtReady: true, mode: 'fixed', size: flags.size || data.meta.size })
  const { page } = run
  const shots = String(flags.shot || '').split(',').filter(Boolean).map(Number)
  try {
    await page.evaluate(() => __kit.seed(1))
    if (scenario?.setup) await page.evaluate(`(${scenario.setup})()`)
    await page.evaluate(d => __kit.startReplay(d), data)
    if (flags.perf) await page.evaluate(n => __kit.startMeasure(n + 10), data.dt.length)
    // run to each screenshot frame, then to the end
    fs.mkdirSync(path.join(dir, '.kit', 'shots'), { recursive: true })
    for (const f of [...shots.sort((a, b) => a - b), data.dt.length]) {
      await page.evaluate(`__kit.runTo(${f})`)
      if (f !== data.dt.length || shots.includes(f)) {
        const out = path.join(dir, '.kit', 'shots', `${name}-${f}.png`)
        await page.screenshot({ path: out })
        console.log(`shot  frame ${f} -> .kit/shots/${name}-${f}.png`)
      }
    }
    const status = await page.evaluate(() => __kit.replayStatus())
    const out = [`kit replay "${name}": ${status.frame}/${status.of} frames`]
    const d = status.diverged
    out.push(d ? `state parts from the recording at frame ${d.frame}: ${d.path} recorded ${JSON.stringify(d.want)?.slice(0, 60)}, replayed ${JSON.stringify(d.got)?.slice(0, 60)}`
      : 'state matches the recording at every check')
    if (flags.perf) {
      const m = await page.evaluate(() => __kit.stopMeasure())
      const gaps = m.gap.slice(1), sorted = [...gaps].sort((a, b) => a - b), at = q => sorted[Math.floor(q * (sorted.length - 1))]?.toFixed(1)
      const worst = gaps.map((g, i) => [i + 1, g]).sort((a, b) => b[1] - a[1]).slice(0, 5)
      out.push(`frame  p50 ${at(0.5)}  p99 ${at(0.99)}  max ${at(1)} ms`)
      out.push(`worst  ${worst.map(([f, g]) => `frame ${f}: ${g.toFixed(1)} ms`).join('  ')}   (kit replay ${name} --shot ${worst[0][0]} to see it)`)
    }
    if (run.errors.length) out.push(`console errors: ${[...new Set(run.errors)].join(' | ').slice(0, 400)}`)
    console.log(out.join('\n'))
    return { failed: !!d || run.errors.some(e => e.startsWith('[pageerror]')) }
  } finally { await run.close() }
}

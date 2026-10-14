// End-to-end tests: run each command on test/demo and check its text output and exit code.
//   npm test
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(root, '..', 'bin', 'kit.mjs')
const DEMO = path.join(root, 'demo')
fs.rmSync(path.join(DEMO, '.kit'), { recursive: true, force: true })

// a copy of the demo with another crate colour (verify must call it a visible change) and a draw-call budget it can't meet
const changed = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-demo-'))
const edit = (f, from, to) => fs.writeFileSync(path.join(changed, f), fs.readFileSync(path.join(DEMO, f), 'utf8').replace(from, to))
fs.copyFileSync(path.join(DEMO, 'index.html'), path.join(changed, 'index.html'))
edit('scene.js', '0x8aa0b4', '0xc04040')
edit('kit.config.mjs', 'drawCalls: 600', 'drawCalls: 100')

// copies with no kit.config.mjs: one for zero-config perf and check, one for kit init
const bare = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  for (const f of ['index.html', 'scene.js']) fs.copyFileSync(path.join(DEMO, f), path.join(d, f))
  return d
}
const plain = bare('kit-plain-'), fresh = bare('kit-fresh-')
fs.writeFileSync(path.join(fresh, '.gitignore'), 'node_modules/\n')
// 25 x 21 crates instead of 21 x 21: 84 more draw calls
const grow = () => fs.writeFileSync(path.join(plain, 'scene.js'), fs.readFileSync(path.join(plain, 'scene.js'), 'utf8').replace('let x = -10; x <= 10', 'let x = -12; x <= 12'))

const kit = (args, dir = DEMO) => {
  const r = spawnSync('node', [CLI, ...args, '--dir', dir], { encoding: 'utf8', timeout: 300000 })
  return { out: `${r.stdout}${r.stderr}`, code: r.status }
}

// [name, args, expected text ('!text' must be absent), expected exit code, project folder, run first]
const cases = [
  ['lint finds the planted allocation', ['lint'], ['alloc-math', 'new Vector3()', 'loop (scene.js) > bob (scene.js)', '0 measured'], 0],
  ['perf reports frames, scene and budgets', ['perf', 'idle', '--save'], ['kit perf "idle"', 'draw calls 442', '444 objects', 'bob scene.js:', 'budgets ok', 'saved as baseline', '!console errors'], 0],
  ['perf compares against the baseline', ['perf', 'idle'], ['(same as baseline)', '(+/- vs baseline)'], 0],
  ['lint ranks by what perf saw running', ['lint'], ['measured: these ran', 'scene.js:47', 'in idle'], 0],
  ['a missed budget fails the run', ['perf', 'idle', '--frames', '60', '--no-profile'], ['BUDGET FAIL  drawCalls 442 > 100'], 1, changed],
  ['determinism: seeded random and fixed clock repeat exactly', ['determinism', 'sparks', '--frames', '300'], ['two runs identical for 300 frames'], 0],
  ['verify: the same code is the same game', ['verify', 'idle', '--ref', '.', '--runs', '2', '--frames', '120'], ['state       identical', 'identical: 0% of pixels changed', 'SAME behavior'], 0],
  ['verify: a colour change is caught', ['verify', 'idle', '--ref', changed, '--runs', '2', '--frames', '120'], ['VISIBLY DIFFERENT', 'BEHAVIOR CHANGED'], 1],
  ['render pass changes nothing visible', ['render', 'idle', '--runs', '2', '--frames', '120'], ['pass        ', 'SAME behavior'], 0],
  ['net lists what a visit downloads', ['net', '--wait', '1'], ['cdn.jsdelivr.net', 'your host: 2 requests', '/scene.js'], 0],
  ['perf charges library cost to the function it ran under', ['perf', 'idle', '--frames', '120'], ['library cpu under your functions', 'library alloc under your functions', 'loop scene.js:', 'painterSortStable', '!(kit probe)'], 0],
  ['check passes against the saved baseline', ['check', 'idle'], ['ok    idle', 'lint', 'check ok'], 0],
  ['zero config: perf finds the renderer and scenes itself', ['perf', '--size', '960x540'], ['kit perf "idle"', 'draw calls 442', '444 objects', 'split  renderer.render', '!console errors'], 0, plain],
  ['zero config: check saves a first baseline', ['check', '--size', '960x540'], ['new   idle', 'saved this run as one', 'check ok'], 0, plain],
  ['check fails when draw calls rise', ['check', '--size', '960x540'], ['FAIL  idle', 'draw calls rose 442 -> 526', 'check FAILED: idle'], 1, plain, grow],
  ['init names the page globals and saves a baseline', ['init', '--size', '960x540'], ['wrote kit.config.mjs', 'renderer  window.demo.renderer', 'window.demo.scene', '.gitignore: added .kit/', 'saved as baseline'], 0, fresh],
  ['init refuses to replace a config', ['init'], ['already exists'], 2, fresh],
]

let failed = 0
for (const [name, args, expects, code, dir, before] of cases) {
  before?.()
  const t = Date.now(), r = kit(args, dir)
  const missing = expects.filter(x => (x.startsWith('!') ? r.out.includes(x.slice(1)) : !r.out.includes(x)))
  if (r.code !== code) missing.push(`exit ${code} (got ${r.code})`)
  if (missing.length) failed++
  const secs = `${Math.round((Date.now() - t) / 1000)}s`
  console.log(`${missing.length ? 'FAIL' : 'ok  '}  ${name} (${secs})${missing.length ? `\n      missing: ${missing.join(' | ')}\n${r.out.trim().split('\n').map(l => '      > ' + l).join('\n')}` : ''}`)
}
for (const d of [changed, plain, fresh]) fs.rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)

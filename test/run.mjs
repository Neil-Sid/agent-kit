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

const kit = (args, dir = DEMO) => {
  const r = spawnSync('node', [CLI, ...args, '--dir', dir], { encoding: 'utf8', timeout: 300000 })
  return { out: `${r.stdout}${r.stderr}`, code: r.status }
}

// [name, args, expected text ('!text' must be absent), expected exit code, project folder]
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
]

let failed = 0
for (const [name, args, expects, code, dir] of cases) {
  const t = Date.now(), r = kit(args, dir)
  const missing = expects.filter(x => (x.startsWith('!') ? r.out.includes(x.slice(1)) : !r.out.includes(x)))
  if (r.code !== code) missing.push(`exit ${code} (got ${r.code})`)
  if (missing.length) failed++
  const secs = `${Math.round((Date.now() - t) / 1000)}s`
  console.log(`${missing.length ? 'FAIL' : 'ok  '}  ${name} (${secs})${missing.length ? `\n      missing: ${missing.join(' | ')}\n${r.out.trim().split('\n').map(l => '      > ' + l).join('\n')}` : ''}`)
}
fs.rmSync(changed, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)

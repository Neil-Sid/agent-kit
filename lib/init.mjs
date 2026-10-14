// kit init: set a project up for the kit. Opens the page the way every command does (the probe finds the renderer,
// scenes and camera on its own), writes a kit.config.mjs naming what it found, then runs kit perf once and keeps that
// as the baseline.
//
//   kit init [--force] [--size WxH]
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { start, perf } from './perf.mjs'
import { withDefaults } from './config.mjs'

const BUNDLERS = ['vite', 'webpack', 'parcel', 'esbuild', 'rollup', '@rspack/core', '@rsbuild/core']
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function init(dir, flags) {
  const file = path.join(dir, 'kit.config.mjs')
  if (fs.existsSync(file) && !flags.force) throw new Error('kit.config.mjs already exists (--force replaces it)')
  const size = flags.size || '1920x1080'

  // a bundled app is measured from its build output
  const pkgFile = path.join(dir, 'package.json')
  const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : {}
  const script = pkg.scripts?.build || ''
  const bundler = BUNDLERS.find(b => pkg.dependencies?.[b] || pkg.devDependencies?.[b]) || script.match(/\b(bun build|vite|webpack|parcel|esbuild|rollup|rspack|rsbuild)\b/)?.[1]
  const serve = bundler && script ? script.match(/--out-?dir[= ]["']?([\w./-]+)/)?.[1].replace(/^\.\//, '') ?? 'dist' : undefined
  const build = serve && 'npm run build'
  if (serve && !fs.existsSync(path.join(dir, serve, 'index.html'))) {
    console.log(`kit init: ${bundler} project, building first (${build})`)
    execSync(build, { cwd: dir, stdio: 'inherit' })
  }
  if (!fs.existsSync(path.join(dir, serve || '', 'index.html'))) throw new Error(`no index.html in ${serve ? `${serve}/` : 'the project folder'} to open`)

  const run = await start(dir, withDefaults({ size, serve }), { freezeAtReady: true, mode: 'fixed' })
  let found
  try { found = await run.page.evaluate(() => __kit.auto.describe()) } finally { await run.close() }

  const kit = path.relative(dir, KIT).replace(/\\/g, '/') || '.'
  const include = ['js', 'src'].filter(d => fs.existsSync(path.join(dir, d)))
  const secs = ms => (ms / 1000).toFixed(1)
  const scenes = found.scenes.map(s => `${s.name || 'Scene'} (${s.objects} objects)`).join(', ')
  const paths = found.scenes.map(s => s.path)
  const line = (code, note) => (note ? `${code.padEnd(44)}// ${note}` : code)
  const text = [
    `// agent-kit config, written by kit init. Every key is optional; ${kit}/AGENTS.md documents them.`,
    '// Functions here run inside the page, so they can only see page globals.',
    `// Found: three r${found.three}, ${found.renderer}, ${found.scenes.length === 1 ? 'one scene' : `${found.scenes.length} scenes`}: ${scenes}.`,
    `// Run from this folder:  node ${/\s/.test(kit) ? `"${kit}/bin/kit.mjs"` : `${kit}/bin/kit.mjs`} check`,
    'export default {',
    `  size: '${size}',`,
    ...(serve ? [line(`  serve: '${serve}',`, 'the build output every command serves'), line(`  site: '${serve}',`, 'what your host serves, for kit net'), `  build: '${build}',`] : []),
    found.readyBy === 'settled'
      ? line('  // ready: () => window.app?.started,', `left out: runs start once loading settles (${secs(found.readyMs)} s after load here)`)
      : line('  // ready: () => window.app?.started,', 'TODO: loading never settled, so the kit waited 10 s; point this at the app\'s own flag'),
    found.rendererPath ? `  renderer: () => ${found.rendererPath},` : line('  // renderer: () => ...,', 'left out: no page global leads to it; the kit uses the one drawing the main scene'),
    paths.every(Boolean) ? `  scenes: () => [${paths.join(', ')}],` : line('  // scenes: () => [...],', 'left out: the kit takes every scene drawn in the last 60 frames'),
    line('  // state: () => ({ ... }),', 'left out: the kit compares the object count, a hash of every position and the camera'),
    '  scenarios: {',
    line('    idle: { warmup: 120, frames: 600 },', 'add your own: { setup: () => {...}, drive: f => {...} }'),
    '  },',
    line('  budgets: {},', 'e.g. { p99: 16, drawCalls: 500, allocKB: 64 }: kit check fails past them'),
    `  lint: { include: [${(include.length ? include : ['.']).map(d => `'${d}'`).join(', ')}] },`,
    '}',
    '',
  ].join('\n')
  fs.writeFileSync(file, text)

  const out = ['kit init: wrote kit.config.mjs', `  three r${found.three}, ${found.renderer}, canvas ${found.canvas}`]
  out.push(`  renderer  ${found.rendererPath ?? 'no page global leads to it: the kit finds it from render calls'}`)
  for (const s of found.scenes) out.push(`  scene     ${s.name || 'Scene'}, ${s.objects} objects: ${s.path ?? 'no page global leads to it'}`)
  out.push(`  camera    ${found.camera ?? 'none seen'} (read from render calls)`)
  out.push(found.readyBy === 'settled' ? `  ready     loading settled ${secs(found.readyMs)} s after load; runs start there`
    : `  ready     loading never settled (still changing 10 s after the first frame): set config.ready to the app's own flag`)
  if (run.errors.length) out.push(`  console errors while loading: ${[...new Set(run.errors)].join(' | ').slice(0, 300)}`)
  const ignore = path.join(dir, '.gitignore')
  if (fs.existsSync(ignore)) {
    const had = fs.readFileSync(ignore, 'utf8')
    if (!/^\/?\.kit\/?\s*$/m.test(had)) { fs.appendFileSync(ignore, `${had.endsWith('\n') ? '' : '\n'}\n# agent-kit output\n.kit/\n`); out.push('  .gitignore: added .kit/') }
  }
  console.log(out.join('\n') + '\n')

  // the written file, imported fresh, so a mistake in it shows up now
  const config = withDefaults((await import(`${pathToFileURL(file)}?t=${Date.now()}`)).default)
  return perf(dir, config, 'idle', { save: true })
}

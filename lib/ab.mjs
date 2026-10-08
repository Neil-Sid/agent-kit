// kit ab: the same scenarios on a git commit (default HEAD) and on the working tree, metrics side by side, with
// screenshots at the same frames diffed pixel by pixel. Answers "did my change make it faster, slower, or different?"
//
//   kit ab <scenario...> [--ref HEAD~1] [--shots 300,900] [--runs 3] [--site dist]
//
// The commit is exported once per hash to .kit/ab/<hash>/ (git's own files only: ignored folders such as assets are
// missing there unless the page loads them from elsewhere). Both sides use the working tree's kit.config.mjs. With
// --site, config.build (e.g. 'npm run build') runs in both trees first and that folder is served.
import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import { measure } from './perf.mjs'
import { diffPairs } from './pixels.mjs'

export const git = (dir, args, env) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
  if (r.status) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`)
  return r.stdout.trim()
}

// The commit's files in .kit/ab/<hash>/, written through a throwaway index so the user's index is untouched.
export function snapshot(dir, hash) {
  const snap = path.join(dir, '.kit', 'ab', hash)
  if (fs.existsSync(path.join(snap, '.complete'))) return snap
  fs.rmSync(snap, { recursive: true, force: true })
  fs.mkdirSync(snap, { recursive: true })
  const env = { GIT_INDEX_FILE: path.join(dir, '.kit', 'ab', `${hash}.index`) }
  git(dir, ['read-tree', hash], env)
  git(dir, ['checkout-index', '-a', '-f', `--prefix=${snap.replace(/\\/g, '/')}/`], env)
  fs.rmSync(env.GIT_INDEX_FILE, { force: true })
  const nm = path.join(dir, 'node_modules')
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(snap, 'node_modules'), 'junction')   // for build steps
  fs.writeFileSync(path.join(snap, '.complete'), '')
  return snap
}

const ROWS = [['fps', 'fps', 1], ['p50', 'p50 ms', -1], ['p95', 'p95 ms', -1], ['p99', 'p99 ms', -1], ['max', 'max ms', -1],
  ['long', 'long frames', -1], ['cpuP50', 'js p50 ms', -1], ['drawCalls', 'draw calls', -1], ['triangles', 'triangles', -1]]

export async function ab(dir, config, names, flags) {
  if (!names.length) throw new Error(`name scenarios to compare (have: ${Object.keys(config.scenarios || {}).join(', ')})`)
  const ref = flags.ref || 'HEAD'
  let hash
  try { hash = git(dir, ['rev-parse', '--short', ref]) } catch { throw new Error(`${dir} is not a git repository (or no commit "${ref}")`) }
  const dirty = git(dir, ['status', '--porcelain']).split('\n').filter(l => l && !l.includes('.kit/'))
  if (ref === 'HEAD' && !dirty.length) console.log('note: no uncommitted changes, so both sides are the same code (try --ref HEAD~1)')
  const snap = snapshot(dir, hash)
  if (flags.site && config.build) for (const d of [snap, dir]) execSync(config.build, { cwd: d, stdio: 'ignore' })

  const shots = String(flags.shots || '').split(',').filter(Boolean).map(Number)
  const out = [`kit ab: ${ref} (${hash}) vs working tree${dirty.length ? ` (${dirty.length} changed files)` : ''}${flags.site ? `, serving ${flags.site}/` : ''}`]
  let failed = false
  for (const name of names) {
    const sc = config.scenarios?.[name] || {}
    const end = +(sc.warmup ?? 120) + +(flags.frames || sc.frames || 600)
    const at = [...new Set([...shots, end])]
    const run = (d, tag) => measure(d, config, name, { ...flags, 'no-profile': !flags.profile, shots: at, shotDir: path.join(dir, '.kit', 'ab', 'shots', tag) })
    const a = await run(snap, hash), b = await run(dir, 'now')
    out.push('', `"${name}"`.padEnd(16) + `${hash}`.padStart(10) + 'now'.padStart(10) + '   change')
    for (const [k, label, better] of ROWS) {
      const x = a.metrics[k], y = b.metrics[k]
      if (x === undefined || y === undefined) continue
      const pct = x ? Math.round((y - x) / x * 100) : 0
      const sign = pct === 0 ? '' : (pct > 0) === (better > 0) ? '  better' : '  worse'
      out.push(`  ${label.padEnd(14)}${String(x).padStart(10)}${String(y).padStart(10)}   ${pct > 0 ? '+' : ''}${pct}%${Math.abs(pct) >= 5 ? sign : ''}`)
    }
    for (const [side, r] of [[hash, a], ['now', b]]) if (r.meta.errors.length) { out.push(`  console errors (${side}): ${r.meta.errors.join(' | ').slice(0, 300)}`); failed ||= side === 'now' }
    const same = a.meta.state && a.meta.state === b.meta.state
    out.push(`  game state at the end: ${same ? 'identical' : 'differs'} (#${a.meta.state} vs #${b.meta.state})${same ? '' : '; for a nondeterministic app some pixel noise is expected'}`)

    // screenshots of the same frames, diffed
    const pairs = a.shots.map(s => ({ frame: s.frame, a: s.file, b: b.shots.find(t => t.frame === s.frame)?.file })).filter(p => p.b)
    const diffs = await diffPairs(pairs.map(p => ({ ...p, diff: path.join(dir, '.kit', 'ab', `${name}-${p.frame}-diff.png`) })))
    for (const [i, d] of diffs.entries()) {
      const verdict = d.changedPct === 0 ? 'identical' : d.changedPct < 0.5 ? 'nearly identical' : 'visibly different'
      out.push(`  frame ${pairs[i].frame}: ${verdict}: ${d.changedPct}% of pixels changed, mean diff ${d.mean}/255  -> ${path.relative(dir, d.diff).replace(/\\/g, '/')}`)
    }
  }
  out.push('', 'speed numbers move 10-30 % with machine load: use --runs 3 before trusting a small change')
  console.log(out.join('\n'))
  return { failed }
}

#!/usr/bin/env node
// agent-kit: text-first perf, lint and replay tools for three.js projects. Run from a project folder that has a
// kit.config.mjs (see AGENTS.md).
//
//   kit perf <scenario> [--frames 600] [--runs n] [--size WxH] [--save] [--no-profile] [--hitches n]
//   kit verify <scenario...> [--ref HEAD|<folder>] [--runs 3]   same behavior? faster? (state checkpoints, pixels, timing)
//   kit render <scenario...> [--apply] | --revert   try the static/batching render pass; install it if it helps
//   kit ab <scenario...> [--ref HEAD] [--shots f1,f2] [--runs n] [--site dist]   commit vs working tree, + pixel diffs
//   kit net [scenario] [--site dist]           what a visit downloads, per host; requests to your own host
//   kit lint [paths...] [--all] [--max n] [--strict]
//   kit determinism <scenario> [--frames 900]   runs twice; names the first random call that differs
//   kit record <name> [--scenario s] [--script f.mjs]   visible window, F8 saves .kit/<name>.replay.json
//   kit replay <name> [--perf] [--shot f1,f2]   headless; reports the first frame the state parts
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [cmd, ...rest] = process.argv.slice(2)
const args = [], flags = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) args.push(a)
  else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[a.slice(2)] = rest[++i]
  else flags[a.slice(2)] = true
}

const dir = path.resolve(flags.dir || process.cwd())
const configFile = path.join(dir, 'kit.config.mjs')
const config = fs.existsSync(configFile) ? (await import(pathToFileURL(configFile))).default : {}

const commands = {
  perf: async () => {
    if (flags.render) flags.inject = (await import('../lib/renderpass.mjs')).injectFor(flags)   // profile with the render pass on
    return (await import('../lib/perf.mjs')).perf(dir, config, args[0] || 'default', flags)
  },
  verify: async () => (await import('../lib/verify.mjs')).verify(dir, config, args, flags),
  render: async () => (await import('../lib/renderpass.mjs')).render(dir, config, args, flags),
  ab: async () => (await import('../lib/ab.mjs')).ab(dir, config, args, flags),
  net: async () => (await import('../lib/net.mjs')).net(dir, config, args[0], flags),
  determinism: async () => (await import('../lib/determinism.mjs')).determinism(dir, config, args[0] || 'default', flags),
  lint: async () => (await import('../lib/lint.mjs')).lint(dir, config.lint || {}, args, flags),
  record: async () => (await import('../lib/replay.mjs')).record(dir, config, args[0] || 'session', flags),
  replay: async () => (await import('../lib/replay.mjs')).replay(dir, config, args[0] || 'session', flags),
}

if (!commands[cmd]) {
  console.log('usage: kit perf <scenario> | kit verify <scenarios> | kit render <scenarios> | kit ab <scenarios> | kit net [scenario] | kit lint [paths] | kit determinism <scenario> | kit record <name> | kit replay <name>')
  process.exit(2)
}
try {
  const res = await commands[cmd]()
  process.exit(res?.failed ? 1 : 0)
} catch (e) {
  console.error(`kit ${cmd}: ${e.message}`)
  process.exit(2)
}

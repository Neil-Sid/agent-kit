// kit net: what a first visit downloads (cache empty), by phase (boot, then an optional scenario) and by host, and the
// requests that reach your own host, which are what a host like Vercel bills.
//
//   kit net [scenario] [--site dist] [--wait 4]
//
// config.site: the folder your host serves (a build output); config.hosting: { requests, bytes } included per month
// in your plan, to turn the numbers into visits per month.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { start } from './perf.mjs'

const kb = b => `${(b / 1024).toFixed(0)} KB`, mb = b => `${(b / 1048576).toFixed(2)} MB`
const OWN = /^http:\/\/127\.0\.0\.1:\d+/

export async function net(dir, config, name, flags) {
  const site = flags.site ?? config.site
  const root = site ? path.join(dir, site) : dir
  const scenario = name && config.scenarios?.[name]
  if (name && !scenario) throw new Error(`no scenario "${name}"`)
  const seen = [], pending = new Map()
  let phase = 'boot'
  const onPage = async page => {
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')                   // a fresh browser profile: the cache starts empty but works
    cdp.on('Network.requestWillBeSent', e => pending.set(e.requestId, { url: e.request.url, phase }))
    cdp.on('Network.responseReceived', e => { const r = pending.get(e.requestId); if (r) { r.status = e.response.status; r.cached = e.response.fromDiskCache || e.response.fromServiceWorker; r.revalidated = e.response.status === 304 } })
    cdp.on('Network.requestServedFromCache', e => { const r = pending.get(e.requestId); if (r) r.cached = true })
    cdp.on('Network.loadingFinished', e => { const r = pending.get(e.requestId); if (r) seen.push({ ...r, bytes: e.encodedDataLength }) })
    cdp.on('Network.loadingFailed', e => { const r = pending.get(e.requestId); if (r) seen.push({ ...r, bytes: 0, failed: e.errorText }) })
  }
  const run = await start(dir, config, { site, onPage, realHost: true, freezeAtReady: !!scenario, mode: scenario ? 'fixed' : undefined })
  try {
    if (scenario) {
      phase = name
      if (scenario.setup) await run.page.evaluate(`(${scenario.setup})()`)
      if (scenario.drive) await run.page.evaluate(`__kit.drive = (${scenario.drive})`)
      await run.page.evaluate(() => __kit.go('fixed'))
      await run.page.evaluate(`__kit.runTo(${+(scenario.warmup ?? 120) + +(scenario.frames ?? 600)})`)
    }
    await new Promise(r => setTimeout(r, +(flags.wait ?? 4) * 1000))      // late loads (fonts, lazy textures)
  } finally { await run.close() }
  report(root, site, name, seen, config.hosting)
}

function report(root, site, name, all, hosting) {
  const sum = list => list.reduce((n, r) => n + r.bytes, 0)
  // same URL asked for more than once: the repeats cost a request (and bytes, if they miss the cache)
  const count = {}
  for (const r of all) count[r.url] = (count[r.url] || 0) + 1
  const dupes = Object.entries(count).filter(([, n]) => n > 1)
  const seen = all.filter(r => !r.cached)
  const hostOf = u => (OWN.test(u) ? 'your host' : new URL(u).host)
  const out = [`kit net: first visit (cache empty) to ${site ? `${site}/` : 'the project root'}${name ? `, then "${name}"` : ''}`]
  for (const ph of ['boot', name].filter(Boolean)) {
    const list = seen.filter(r => r.phase === ph)
    out.push(`  ${ph.padEnd(12)} ${mb(sum(list)).padStart(9)}  ${list.length} files`)
  }
  out.push(`  ${'total'.padEnd(12)} ${mb(sum(seen)).padStart(9)}  ${seen.length} files`, '', 'by host:')
  const hosts = {}
  for (const r of seen) (hosts[hostOf(r.url)] ??= []).push(r)
  for (const [h, list] of Object.entries(hosts).sort((a, b) => sum(b[1]) - sum(a[1]))) out.push(`  ${mb(sum(list)).padStart(9)}  ${String(list.length).padStart(3)} files  ${h}`)

  // own host: sizes as a real host would send them (the kit's server does not compress)
  const own = seen.filter(r => OWN.test(r.url) && !r.failed && r.status < 400)
  let raw = 0, gz = 0
  const files = own.map(r => {
    const p = new URL(r.url).pathname, file = path.join(root, p === '/' ? 'index.html' : decodeURIComponent(p))
    const body = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
    const z = zlib.gzipSync(body).length
    raw += body.length; gz += z
    return `${p} ${kb(body.length)}`
  })
  out.push('', `your host: ${own.length} requests, ${kb(raw)} raw, ~${kb(gz)} gzip`, `  ${files.join(', ')}`)
  if (dupes.length) {
    // the repeats of each URL: from the browser cache, revalidated (a request, ~no bytes), or downloaded again
    const repeats = dupes.flatMap(([u]) => all.filter(r => r.url === u).slice(1))
    const again = repeats.filter(r => !r.cached && !r.revalidated)
    out.push('', `requested more than once (${dupes.length} URLs): ${dupes.slice(0, 8).map(([u, n]) => `${u.replace(OWN, '').replace(/^https?:\/\//, '')} x${n}`).join(', ')}${dupes.length > 8 ? ', ...' : ''}`,
      `  repeats: ${repeats.filter(r => r.cached).length} from cache, ${repeats.filter(r => r.revalidated).length} revalidated (304), ${again.length} downloaded again (${mb(sum(again))})`)
  }
  const bad = seen.filter(r => r.failed || r.status >= 400)
  if (bad.length) out.push(`failed or missing: ${bad.map(r => `${r.url.replace(OWN, '')} (${r.failed || r.status})`).join(', ')}`)
  out.push('', 'biggest files:', ...[...seen].sort((a, b) => b.bytes - a.bytes).slice(0, 6).map(r => `  ${mb(r.bytes).padStart(9)}  ${r.url.replace(/^https?:\/\//, '').slice(0, 100)}`))

  if (hosting && own.length) {
    const byReq = hosting.requests / own.length, byBytes = hosting.bytes / gz
    out.push('', `hosting allowance: ${(hosting.requests / 1e6).toFixed(0)}M requests / ${own.length} per visit = ${(byReq / 1e6).toFixed(2)}M visits; ` +
      `${(hosting.bytes / 1e12).toFixed(1)} TB / ${kb(gz)} = ${(byBytes / 1e6).toFixed(1)}M visits -> about ${(Math.min(byReq, byBytes) / 1e6).toFixed(2)}M visits a month ` +
      `(${byReq < byBytes ? 'requests' : 'transfer'} run out first). Repeat visits re-request files unless they are cached.`)
  }
  console.log(out.join('\n'))
}

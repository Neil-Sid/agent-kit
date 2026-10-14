// Static server for a project folder and a headless Chrome on the real GPU with the frame cap off,
// so requestAnimationFrame runs flat out and frame gaps measure real cost.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROMES = {
  win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .map(d => path.join(d, 'Google/Chrome/Application/chrome.exe')),
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
}
// ANGLE on the platform's native GPU API; Linux keeps Chrome's default
const ANGLE = { win32: ['--use-angle=d3d11'], darwin: ['--use-angle=metal'] }[process.platform] || []

function chrome() {
  const found = process.env.KIT_CHROME || (CHROMES[process.platform] || []).find(f => fs.existsSync(f))
  if (!found) throw new Error('Chrome not found: set KIT_CHROME to the Chrome or Chromium executable')
  return found
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

// realHost: behave like a static host (Vercel: revalidate every time, ETag, 304 Not Modified) instead of no-store,
// so kit net sees what the browser cache really saves.
export function serve(root, { realHost = false } = {}) {
  root = path.resolve(root)
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(root, url === '/' ? 'index.html' : url)
    // Chrome asks for a favicon on its own; a missing one isn't the page's console error
    if (!realHost && url === '/favicon.ico' && !fs.existsSync(file)) { res.writeHead(204); return res.end() }
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    const st = fs.statSync(file), etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`
    const type = MIME[path.extname(file)] || 'application/octet-stream'
    if (!realHost) res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    else if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end() }
    else res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

// headed: true opens a visible window (recording); otherwise headless on the GPU.
export async function launch({ width, height, headed = false }) {
  return puppeteer.launch({
    executablePath: chrome(), headless: !headed, protocolTimeout: 600000, defaultViewport: headed ? null : { width, height },
    args: [
      ...ANGLE, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--mute-audio', '--enable-precise-memory-info',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      ...(headed ? [`--window-size=${width},${height}`] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']),
    ],
  })
}

// Open the project page with the probe installed before any of its scripts, and wait until it says it is ready.
export async function open(browser, url, { probe, arg, ready, timeout = 90000, onPage }) {
  const page = (await browser.pages())[0] || await browser.newPage()
  await onPage?.(page)                   // e.g. start recording network traffic before the first request
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
  // named, so profiles can tell the probe's own frames from the page's (profile.mjs)
  await page.evaluateOnNewDocument(`(${probe})(${JSON.stringify(arg)})\n//# sourceURL=kit-probe.js`)
  await page.goto(url, { timeout })
  // polled from Node: page-side polling uses the page's timers, which the probe may hold on the game clock
  for (const t = Date.now(); !(await page.evaluate(ready)); await new Promise(r => setTimeout(r, 250)))
    if (Date.now() - t > timeout) {
      const why = await page.evaluate(() => window.__kit?.why?.()).catch(() => null)
      throw new Error(`page not ready within ${timeout / 1000}s: ${why || ready}`)
    }
  return { page, errors }
}

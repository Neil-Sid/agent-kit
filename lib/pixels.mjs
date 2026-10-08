// Pixel comparison of screenshot pairs, done in a headless page (Chrome decodes and encodes PNGs; no npm image
// library needed). For each pair: mean and max channel difference, the share of pixels that changed visibly, and a
// diff image: the new frame dimmed, with changed pixels painted red.
import fs from 'node:fs'
import { launch } from './browser.mjs'

const VISIBLE = 24          // a channel difference above this (of 255) counts as a visible change

export async function diffPairs(pairs) {
  const browser = await launch({ width: 800, height: 600 })
  try {
    const page = await browser.newPage()
    const out = []
    for (const { a, b, diff } of pairs) {
      const url = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
      const r = await page.evaluate(compare, url(a), url(b), VISIBLE)
      if (diff) fs.writeFileSync(diff, Buffer.from(r.png, 'base64'))
      delete r.png
      out.push({ a, b, diff, ...r })
    }
    return out
  } finally { await browser.close() }
}

// Like diffPairs, with a second shot of the reference (a2) taken in another run of the same code: pixels that differ
// between a and a2 are the app's own run-to-run noise, and only changes outside them count. The diff image shows
// real changes in red and the noise in blue.
export async function diffTriples(triples) {
  const browser = await launch({ width: 800, height: 600 })
  try {
    const page = await browser.newPage(), out = []
    for (const { a, a2, b, diff } of triples) {
      const url = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
      const r = await page.evaluate(compareNoise, url(a), url(a2), url(b), VISIBLE)
      if (diff) fs.writeFileSync(diff, Buffer.from(r.png, 'base64'))
      delete r.png
      out.push({ a, a2, b, diff, ...r })
    }
    return out
  } finally { await browser.close() }
}

// Runs in the page.
async function compareNoise(a, a2, b, visible) {
  const load = src => new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.src = src })
  const ims = await Promise.all([load(a), load(a2), load(b)])
  const w = Math.min(...ims.map(i => i.width)), h = Math.min(...ims.map(i => i.height))
  const pixels = im => { const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h) }
  const pa = pixels(ims[0]).data, pn = pixels(ims[1]).data, img = pixels(ims[2]), pb = img.data
  const far = (p, q, k) => Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2])) > visible
  // one extra run only samples the noise, so it is widened: by 2 px everywhere (sparse noise such as streamed star
  // dots), and by whole 16 px tiles plus their neighbours where it is dense (an animated character)
  const n = new Uint8Array(w * h)
  for (let k = 0, i = 0; k < pa.length; k += 4, i++) n[i] = far(pa, pn, k) ? 1 : 0
  const T = 16, tw = Math.ceil(w / T), th = Math.ceil(h / T), count = new Uint16Array(tw * th), dense = new Uint8Array(tw * th)
  for (let i = 0; i < n.length; i++) if (n[i]) count[((i / w | 0) / T | 0) * tw + ((i % w) / T | 0)]++
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (count[y * tw + x] > T * T * 0.05)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < tw && Y < th) dense[Y * tw + X] = 1 }
  const grow = (src, dx, dy) => {         // 5-wide max filter along one axis
    const out = new Uint8Array(src.length)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (src[y * w + x])
      for (let d = -2; d <= 2; d++) { const X = x + d * dx, Y = y + d * dy; if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1 }
    return out
  }
  const wide = grow(grow(n, 1, 0), 0, 1)
  let noise = 0, changed = 0
  for (let k = 0, i = 0; k < pa.length; k += 4, i++) {
    const noisy = wide[i] === 1 || dense[((i / w | 0) / T | 0) * tw + ((i % w) / T | 0)] === 1, moved = far(pa, pb, k)
    if (noisy) noise++
    if (moved && !noisy) { changed++; pb[k] = 255; pb[k + 1] = 40; pb[k + 2] = 40 }
    else if (noisy && moved) { pb[k] = 40; pb[k + 1] = 90; pb[k + 2] = 255 }
    else for (let c = 0; c < 3; c++) pb[k + c] *= 0.35
  }
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d').putImageData(img, 0, 0)
  const blob = await c.convertToBlob()
  const png = (await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob) })).split(',')[1]
  return { changedPct: +(changed / (w * h) * 100).toFixed(2), noisePct: +(noise / (w * h) * 100).toFixed(2), png }
}

// Runs in the page.
async function compare(a, b, visible) {
  const load = src => new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.src = src })
  const [A, B] = await Promise.all([load(a), load(b)])
  const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height)
  const pixels = im => { const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h) }
  const pa = pixels(A).data, img = pixels(B), pb = img.data
  let sum = 0, max = 0, changed = 0
  for (let k = 0; k < pa.length; k += 4) {
    let d = 0
    for (let c = 0; c < 3; c++) { const x = Math.abs(pa[k + c] - pb[k + c]); sum += x; if (x > d) d = x }
    if (d > max) max = d
    if (d > visible) { changed++; pb[k] = 255; pb[k + 1] = 40; pb[k + 2] = 40 }
    else for (let c = 0; c < 3; c++) pb[k + c] *= 0.35
  }
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d').putImageData(img, 0, 0)
  const blob = await c.convertToBlob()
  const png = (await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob) })).split(',')[1]
  return { mean: +(sum / (w * h * 3)).toFixed(2), max, changedPct: +(changed / (w * h) * 100).toFixed(2), sizeMismatch: A.width !== B.width || A.height !== B.height, png }
}

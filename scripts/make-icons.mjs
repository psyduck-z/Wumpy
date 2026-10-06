/**
 * Builds every icon Wumpy needs from the single source artwork, `logo.png`.
 *
 * Emits the tray icon, the app icon, a multi-resolution .ico for
 * electron-builder, and a copy for the renderer to show in the panel. Corners
 * are rounded with a real alpha mask so the icon sits cleanly on any
 * background rather than as a hard square.
 *
 * Run with: node scripts/make-icons.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = 'logo.png'
const ICON_DIR = 'resources'
const RENDERER_DIR = 'src/renderer/src/assets'
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/* ----------------------------------------------------------------- decode */

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Minimal PNG reader: 8-bit RGB or RGBA, non-interlaced. Returns RGBA. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')

  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colorType = buf[25]
  const interlace = buf[28]

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}; expected 8`)
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported colour type ${colorType}; expected RGB or RGBA`)
  }

  const channels = colorType === 6 ? 4 : 3

  // Concatenate IDAT payloads, which may be split across chunks.
  const parts = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len))
    if (type === 'IEND') break
    off += 12 + len
  }

  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    raw.copy(line, 0, pos, pos + stride)
    pos += stride

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break
        case 2: line[i] = (line[i] + b) & 0xff; break
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break
        default: break // 0 = none
      }
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = line[s]
      out[d + 1] = line[s + 1]
      out[d + 2] = line[s + 2]
      out[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    line.copy(prev)
  }

  return { width, height, data: out }
}

/* ---------------------------------------------------------------- resample */

/** Box-filter downscale. Averaging every source pixel keeps small sizes sharp. */
function resize(src, size) {
  const out = new Uint8Array(size * size * 4)
  const scaleX = src.width / size
  const scaleY = src.height / size

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX))

      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4
          const alpha = src.data[i + 3] / 255
          // Weight colour by alpha so transparent edges do not darken the result.
          r += src.data[i] * alpha
          g += src.data[i + 1] * alpha
          b += src.data[i + 2] * alpha
          a += src.data[i + 3]
          n++
        }
      }
      const aAvg = a / n
      const w = aAvg / 255 || 1
      const d = (y * size + x) * 4
      out[d] = Math.round(r / n / w)
      out[d + 1] = Math.round(g / n / w)
      out[d + 2] = Math.round(b / n / w)
      out[d + 3] = Math.round(aAvg)
    }
  }
  return { width: size, height: size, data: out }
}

/** Multiplies in a rounded-rectangle alpha mask, antialiased. */
function roundCorners(img, radiusRatio = 0.22) {
  const { width: size, data } = img
  const r = size * radiusRatio
  const ss = 3 // supersample the mask edge only

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss
          const py = y + (sy + 0.5) / ss
          const qx = Math.abs(px - size / 2) - (size / 2 - r)
          const qy = Math.abs(py - size / 2) - (size / 2 - r)
          const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
          if (d <= 0) covered++
        }
      }
      const i = (y * size + x) * 4 + 3
      data[i] = Math.round(data[i] * (covered / (ss * ss)))
    }
  }
  return img
}

/* ----------------------------------------------------------------- encode */

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(img) {
  const { width: size, data } = img
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO wrapping PNG entries, which Windows has accepted since Vista. */
function encodeICO(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  for (let i = 0; i < entries.length; i++) {
    const { size, png } = entries[i]
    const o = i * 16
    dir[o] = size >= 256 ? 0 : size
    dir[o + 1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  }
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/* ------------------------------------------------------------------- main */

if (!existsSync(SOURCE)) {
  console.error(`[icons] ${SOURCE} is missing. It is the source artwork for every icon.`)
  process.exit(1)
}

const source = decodePNG(readFileSync(SOURCE))
mkdirSync(ICON_DIR, { recursive: true })
mkdirSync(RENDERER_DIR, { recursive: true })

const entries = SIZES.map((size) => ({
  size,
  png: encodePNG(roundCorners(resize(source, size)))
}))

for (const { size, png } of entries) writeFileSync(join(ICON_DIR, `icon-${size}.png`), png)

const at = (n) => entries.find((e) => e.size === n).png
writeFileSync(join(ICON_DIR, 'icon.png'), at(256))
writeFileSync(join(ICON_DIR, 'tray.png'), at(32))
writeFileSync(join(ICON_DIR, 'icon.ico'), encodeICO(entries))
// The renderer shows the mark in the panel; 128 is plenty at any panel size.
writeFileSync(join(RENDERER_DIR, 'logo.png'), at(128))

console.log(
  `[icons] ${source.width}x${source.height} ${SOURCE} -> ` +
    `${SIZES.length} PNGs, icon.ico, tray.png, renderer asset`
)

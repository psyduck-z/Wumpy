/**
 * Generates the tray + app icons so the repo carries no opaque binaries.
 * Draws a rounded "W" mark, then writes 16/24/32/48/64/128/256px PNGs and a
 * multi-resolution .ico for electron-builder.
 *
 * Run with: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'resources'
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const BG = [99, 102, 241] // indigo
const BG2 = [139, 92, 246] // violet
const FG = [255, 255, 255]

/** Signed distance from p to the segment ab, used to stroke the W. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function roundedRectDist(px, py, w, h, r) {
  // Negative inside, positive outside.
  const qx = Math.abs(px - w / 2) - (w / 2 - r)
  const qy = Math.abs(py - h / 2) - (h / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r
}

function renderRGBA(size) {
  const ss = 4 // supersample factor for antialiasing
  const px = new Uint8Array(size * size * 4)
  const radius = size * 0.26

  // "W" strokes in a normalised 0..1 box, inset from the tile edges.
  const inset = 0.28
  const top = inset
  const bottom = 1 - inset
  const pts = [
    [inset, top],
    [inset + (1 - 2 * inset) * 0.3, bottom],
    [0.5, top + (bottom - top) * 0.45],
    [1 - inset - (1 - 2 * inset) * 0.3, bottom],
    [1 - inset, top]
  ]
  const stroke = size * 0.072

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss
          const fy = y + (sy + 0.5) / ss

          const tileD = roundedRectDist(fx, fy, size, size, radius)
          const tileA = Math.max(0, Math.min(1, 0.5 - tileD))
          if (tileA <= 0) continue

          // Diagonal gradient across the tile.
          const t = (fx / size) * 0.5 + (fy / size) * 0.5
          let cr = BG[0] + (BG2[0] - BG[0]) * t
          let cg = BG[1] + (BG2[1] - BG[1]) * t
          let cb = BG[2] + (BG2[2] - BG[2]) * t

          let glyph = Infinity
          for (let i = 0; i < pts.length - 1; i++) {
            glyph = Math.min(
              glyph,
              distToSegment(
                fx,
                fy,
                pts[i][0] * size,
                pts[i][1] * size,
                pts[i + 1][0] * size,
                pts[i + 1][1] * size
              )
            )
          }
          const glyphA = Math.max(0, Math.min(1, stroke / 2 - glyph + 0.5))
          cr = cr + (FG[0] - cr) * glyphA
          cg = cg + (FG[1] - cg) * glyphA
          cb = cb + (FG[2] - cb) * glyphA

          r += cr * tileA
          g += cg * tileA
          b += cb * tileA
          a += tileA
        }
      }

      const n = ss * ss
      const i = (y * size + x) * 4
      if (a > 0) {
        px[i] = Math.round(r / a)
        px[i + 1] = Math.round(g / a)
        px[i + 2] = Math.round(b / a)
        px[i + 3] = Math.round((a / n) * 255)
      }
    }
  }
  return px
}

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

function toPNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO wrapping PNG-compressed entries, which Windows has accepted since Vista. */
function toICO(entries) {
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
    dir[o + 2] = 0 // palette
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32BE(0, o + 8)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  }
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

mkdirSync(OUT, { recursive: true })

const entries = SIZES.map((size) => ({ size, png: toPNG(size, renderRGBA(size)) }))
for (const { size, png } of entries) {
  writeFileSync(join(OUT, `icon-${size}.png`), png)
}
writeFileSync(join(OUT, 'icon.png'), entries.find((e) => e.size === 256).png)
writeFileSync(join(OUT, 'tray.png'), entries.find((e) => e.size === 32).png)
writeFileSync(join(OUT, 'icon.ico'), toICO(entries.filter((e) => e.size <= 256)))

console.log(`wrote ${SIZES.length + 3} icon files to ${OUT}/`)

/**
 * Pictures with known answers, drawn here so a model can be asked whether
 * it really sees.
 *
 * `sees` is one bit and it was doing too much work. It decides whether to
 * send the bytes, which is all it should decide - and on 19 Oct a sweep
 * found it wrong for half the catalogue, with three models quietly denied
 * every picture they could have read. The bit is now set by asking, and
 * this is what gets asked.
 *
 * The question that matters is not "can it decode a PNG". It is "can it
 * read the error in this screenshot", and a model can pass the first and
 * fail the second completely. So the images get harder: a colour on a
 * side, then shapes to count, then a four-digit number at 24 pixels, then
 * the same at 8 - roughly what real UI text becomes once a screenshot has
 * been scaled down - and finally that number inside one of two coloured
 * boxes, which is the shape of every real question about a screen. Not
 * "what does it say" but "what does THIS one say".
 *
 * EVERY IMAGE IS GENERATED AND EVERY NUMBER IS RANDOM, so no answer can
 * come from having seen the picture before and the right answer is known
 * exactly rather than judged by another model.
 *
 * Lived in scripts/bench-vision.mjs first, where only someone holding the
 * repo could run it. The app needs it too - `/model check` should be able
 * to say whether a model can see, not just whether it answers - so the
 * drawing moved here, where it is pure and checkable, and the script and
 * the app ask the same questions.
 */

/**
 * A 5x7 bitmap digit.
 *
 * Rendering text needs either a font file or ten glyphs typed out. Ten
 * glyphs have no dependency, no licence and no loading, and digits are
 * all these questions need.
 */
const DIGITS: readonly (readonly string[])[] = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
]

export type Rgb = readonly [number, number, number]

export const RED: Rgb = [220, 30, 30]
export const BLUE: Rgb = [30, 60, 220]
export const GREEN: Rgb = [20, 160, 60]
export const BLACK: Rgb = [10, 10, 10]
export const WHITE: Rgb = [255, 255, 255]

export interface Canvas {
  w: number
  h: number
  px: Uint8Array
}

export function canvas(w: number, h: number, fill: Rgb = WHITE): Canvas {
  const px = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = fill[0]
    px[i * 3 + 1] = fill[1]
    px[i * 3 + 2] = fill[2]
  }
  return { w, h, px }
}

export function rect(c: Canvas, x0: number, y0: number, w: number, h: number, rgb: Rgb): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= c.w || y >= c.h) continue
      const i = (y * c.w + x) * 3
      c.px[i] = rgb[0]
      c.px[i + 1] = rgb[1]
      c.px[i + 2] = rgb[2]
    }
  }
}

/** Digits at `scale` pixels per bitmap pixel, so 1 is 5x7 and 4 is 20x28. */
export function drawDigits(
  c: Canvas,
  digits: string,
  x0: number,
  y0: number,
  scale: number,
  rgb: Rgb
): void {
  let x = x0
  for (const ch of digits) {
    const glyph = DIGITS[Number(ch)]
    if (!glyph) continue
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] === '1') rect(c, x + gx * scale, y0 + gy * scale, scale, scale, rgb)
      }
    }
    x += (5 + 1) * scale
  }
}

/* ------------------------------------------------------------ encoding */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let x = n
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1
    table[n] = x >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let r = 0xffffffff
  for (const b of bytes) r = CRC_TABLE[(r ^ b) & 0xff] ^ (r >>> 8)
  return (r ^ 0xffffffff) >>> 0
}

/**
 * A PNG, with the one compression method every decoder must support.
 *
 * `deflate` is a dependency the renderer does not have and the main
 * process would have to be asked for, so these are stored UNCOMPRESSED -
 * zlib's "stored" blocks, which is a legal deflate stream and about four
 * lines. A 300x120 test image is some 108KB raw, which would matter if
 * these were being saved and does not when they are base64'd straight
 * into one request and thrown away.
 *
 * "Legal" was an assumption until it was not. Decoders vary, and an
 * image every library accepts is not the same as one a vision model
 * reads - so both were checked on 21 Oct, against both backends the app
 * actually uses:
 *
 *   zlib.inflateSync    27,744 bytes out of a 96x96, exactly as expected
 *   Ollama, gemma4      read the number in the red box, both ways round
 *   NVIDIA, VL model    read it too, first try
 *
 * Which matters more than it sounds: if the encoder were subtly wrong,
 * every model would score zero on the vision ladder and the catalogue
 * would record a list of blind models that can all see perfectly well.
 * The test would fail in the direction of being believed.
 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01]
  const MAX = 65535
  for (let at = 0; at < raw.length; at += MAX) {
    const chunk = raw.subarray(at, Math.min(at + MAX, raw.length))
    const last = at + MAX >= raw.length ? 1 : 0
    blocks.push(last, chunk.length & 0xff, chunk.length >> 8, ~chunk.length & 0xff, (~chunk.length >> 8) & 0xff)
    for (const b of chunk) blocks.push(b)
  }
  /* Adler-32 of the uncompressed bytes, which zlib puts on the end. */
  let a = 1
  let b = 0
  for (const byte of raw) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  blocks.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff)
  return new Uint8Array(blocks)
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export function toPng(c: Canvas): Uint8Array {
  const raw = new Uint8Array((c.w * 3 + 1) * c.h)
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0
    raw.set(c.px.subarray(y * c.w * 3, (y + 1) * c.w * 3), y * (c.w * 3 + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, c.w)
  view.setUint32(4, c.h)
  ihdr[8] = 8
  ihdr[9] = 2
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0))
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return png
}

export function dataUrl(c: Canvas): string {
  let binary = ''
  for (const b of toPng(c)) binary += String.fromCharCode(b)
  return `data:image/png;base64,${btoa(binary)}`
}

/* --------------------------------------------------------- the questions */

export interface VisionTask {
  level: number
  name: string
  image: Canvas
  ask: string
  /** The one answer that counts as having seen it. */
  want: RegExp
}

const four = (): string => String(Math.floor(Math.random() * 9000) + 1000)

/**
 * The ladder, hardest last.
 *
 * `flip` swaps the sides, and every question that has two answers is
 * asked both ways by the caller - a model that always says "red" would
 * otherwise score half of them without opening its eyes.
 */
export function visionTask(level: number, flip = false): VisionTask {
  if (level === 1) {
    const c = canvas(96, 96)
    rect(c, 0, 0, 48, 96, flip ? BLUE : RED)
    rect(c, 48, 0, 48, 96, flip ? RED : BLUE)
    return {
      level,
      name: 'colour and position',
      image: c,
      ask: 'Which colour fills the LEFT half of this image? One word.',
      want: flip ? /blue/i : /red/i
    }
  }
  if (level === 2) {
    const n = flip ? 5 : 3
    const c = canvas(160, 96)
    for (let i = 0; i < n; i++) rect(c, 8 + i * 30, 36, 22, 22, BLUE)
    return {
      level,
      name: 'counting shapes',
      image: c,
      ask: 'How many blue squares are in this image? Just the number.',
      want: new RegExp(`\\b${n}\\b|\\b${['zero', 'one', 'two', 'three', 'four', 'five'][n]}\\b`, 'i')
    }
  }
  if (level === 3 || level === 4) {
    const n = four()
    const c = canvas(240, 80)
    /* Scale 8 is about 24 pixels tall; scale 2 is 8, which is roughly
       what real interface text becomes in a scaled-down screenshot. */
    drawDigits(c, n, 20, level === 3 ? 12 : 30, level === 3 ? 8 : 2, BLACK)
    return {
      level,
      name: level === 3 ? 'large text' : 'small text, the size real UI becomes',
      image: c,
      ask: 'What number is written in this image? Digits only.',
      want: new RegExp(n)
    }
  }
  /* Two labels told apart only by the colour of the box they sit in,
     which is the shape of every real question about a screen. */
  const a = four()
  let b = four()
  while (b === a) b = four()
  const small = level >= 6
  const c = canvas(300, 120)
  const other = small ? GREEN : BLUE
  rect(c, 10, 10, 130, 100, flip ? other : RED)
  rect(c, 160, 10, 130, 100, flip ? RED : other)
  drawDigits(c, a, small ? 40 : 24, small ? 52 : 45, small ? 2 : 4, WHITE)
  drawDigits(c, b, small ? 190 : 174, small ? 52 : 45, small ? 2 : 4, WHITE)
  return {
    level,
    name: small ? 'small text in the right place' : 'text AND position',
    image: c,
    ask: 'What number is written inside the RED box? Digits only.',
    want: new RegExp(flip ? b : a)
  }
}

export const VISION_LEVELS = [1, 2, 3, 4, 5, 6] as const

/** Whether a question has two sides worth asking both of. */
export function bothWays(level: number): boolean {
  return level !== 3 && level !== 4
}

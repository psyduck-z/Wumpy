/**
 * How well does a model actually SEE, not whether it claims to.
 *
 * `sees` in the catalogue is one bit, set by asking a model whether a
 * 64x64 image is red on the left. That is the right question for "can it
 * read a picture at all" and a useless one for "can it read the error in
 * this screenshot", which is what anyone actually points Wumpy at. A model
 * that passes red-versus-blue and cannot read eight-pixel text is marked
 * as having eyes and will fail the only job it is given.
 *
 * So this is a ladder, like the capability one: it climbs until the model
 * falls off, and the answer is a rung rather than a boolean.
 *
 *   V1  colour and position - the existing bar, kept as the floor
 *   V2  counting - three squares or five
 *   V3  large text - a four-digit number 24 pixels tall
 *   V4  small text - the same thing at 8 pixels, which is roughly what
 *       real UI text becomes in a downscaled screenshot
 *   V5  text AND position together, which is every real question about a
 *       screen: not "what does it say" but "what does THIS one say"
 *
 * EVERY IMAGE IS GENERATED HERE, so no answer can come from having seen
 * the picture before, and the right answer is known exactly rather than
 * judged. The numbers are random per run for the same reason: a model
 * that learned the test would still have to look.
 *
 * Every rung is asked both ways round where it can be - red left and red
 * right, the number here and the number there - because half of these
 * questions have two answers and a model that always says the same thing
 * would score 50% without opening its eyes.
 *
 *   node scripts/bench-vision.mjs
 *   node scripts/bench-vision.mjs nvidia:deepseek-ai/deepseek-v4.1-flash
 *   VISION_SHOW=1 node scripts/bench-vision.mjs
 *
 * NOT part of `npm run typecheck`: it costs real requests and real images.
 */
import { build } from 'esbuild'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(String.fromCharCode(10))) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const out = '.vision-bench.mjs'
await build({
  entryPoints: ['src/shared/cloud.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const C = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const NL = String.fromCharCode(10)
const SHOW = Boolean(process.env.VISION_SHOW)

/* ------------------------------------------------------------ drawing */

/* A 5x7 bitmap digit, because rendering text needs either a font file or
   ten glyphs typed out, and ten glyphs have no dependency and no licence. */
const DIGITS = [
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

function canvas(w, h, fill = [255, 255, 255]) {
  const px = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = fill[0]
    px[i * 3 + 1] = fill[1]
    px[i * 3 + 2] = fill[2]
  }
  return { w, h, px }
}

function rect(c, x0, y0, w, h, rgb) {
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
function text(c, digits, x0, y0, scale, rgb) {
  let x = x0
  for (const ch of String(digits)) {
    const glyph = DIGITS[Number(ch)]
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] === '1') rect(c, x + gx * scale, y0 + gy * scale, scale, scale, rgb)
      }
    }
    x += (5 + 1) * scale
  }
}

function png(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h)
  let o = 0
  for (let y = 0; y < c.h; y++) {
    raw[o++] = 0
    c.px.copy(raw, o, y * c.w * 3, (y + 1) * c.w * 3)
    o += c.w * 3
  }
  const table = []
  for (let n = 0; n < 256; n++) {
    let x = n
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1
    table[n] = x >>> 0
  }
  const crc = (buf) => {
    let r = 0xffffffff
    for (const b of buf) r = table[(r ^ b) & 0xff] ^ (r >>> 8)
    return (r ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const cc = Buffer.alloc(4)
    cc.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(c.w, 0)
  ihdr.writeUInt32BE(c.h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const RED = [220, 30, 30]
const BLUE = [30, 60, 220]
const BLACK = [10, 10, 10]
const GREEN = [20, 160, 60]

const digits = (n) => String(Math.floor(Math.random() * 9000) + 1000).slice(0, n)

/* -------------------------------------------------------------- rungs */

/**
 * Each rung builds its own image and knows its own answer.
 *
 * `both` runs the question twice with the sides swapped, so a model that
 * always answers "red" scores zero rather than half.
 */
const RUNGS = [
  {
    level: 1,
    name: 'colour and position',
    both: true,
    make(flip) {
      const c = canvas(96, 96)
      rect(c, 0, 0, 48, 96, flip ? BLUE : RED)
      rect(c, 48, 0, 48, 96, flip ? RED : BLUE)
      return { image: c, ask: 'Which colour fills the LEFT half of this image? One word.', want: flip ? /blue/i : /red/i }
    }
  },
  {
    level: 2,
    name: 'counting shapes',
    both: true,
    make(flip) {
      const c = canvas(160, 96)
      const n = flip ? 5 : 3
      for (let i = 0; i < n; i++) rect(c, 8 + i * 30, 36, 22, 22, BLUE)
      return { image: c, ask: 'How many blue squares are in this image? Answer with just the number.', want: new RegExp(`\\b${n}\\b|\\b${['zero','one','two','three','four','five'][n]}\\b`, 'i') }
    }
  },
  {
    level: 3,
    name: 'large text',
    both: false,
    make() {
      const n = digits(4)
      const c = canvas(240, 80)
      text(c, n, 20, 12, 8, BLACK)
      return { image: c, ask: 'What number is written in this image? Digits only.', want: new RegExp(n) }
    }
  },
  {
    level: 4,
    name: 'small text, the size real UI becomes',
    both: false,
    make() {
      const n = digits(4)
      const c = canvas(240, 80)
      text(c, n, 20, 30, 2, BLACK)
      return { image: c, ask: 'What number is written in this image? Digits only.', want: new RegExp(n) }
    }
  },
  {
    level: 5,
    name: 'text AND position, which is every real question',
    both: true,
    make(flip) {
      const a = digits(4)
      let b = digits(4)
      while (b === a) b = digits(4)
      const c = canvas(300, 120)
      /* Two labels, told apart only by which coloured box they sit in -
         the shape of "what does the red one say", which is what someone
         asks about a screen. */
      rect(c, 10, 10, 130, 100, flip ? BLUE : RED)
      rect(c, 160, 10, 130, 100, flip ? RED : BLUE)
      text(c, a, 24, 45, 4, [255, 255, 255])
      text(c, b, 174, 45, 4, [255, 255, 255])
      return {
        image: c,
        ask: 'What number is written inside the RED box? Digits only.',
        want: new RegExp(flip ? b : a)
      }
    }
  },
  {
    level: 6,
    name: 'small text in the right place',
    both: true,
    make(flip) {
      const a = digits(4)
      let b = digits(4)
      while (b === a) b = digits(4)
      const c = canvas(300, 120)
      rect(c, 10, 10, 130, 100, flip ? GREEN : RED)
      rect(c, 160, 10, 130, 100, flip ? RED : GREEN)
      text(c, a, 40, 52, 2, [255, 255, 255])
      text(c, b, 190, 52, 2, [255, 255, 255])
      return {
        image: c,
        ask: 'What number is written inside the RED box? Digits only.',
        want: new RegExp(flip ? b : a)
      }
    }
  }
]

/* ------------------------------------------------------------- asking */

const KEY = {
  nvidia: () => process.env.NVIDIA_BENCH_KEY ?? process.env.NVIDIA_API_KEY ?? '',
  google: () => (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? '').split(',')[0]?.trim() ?? '',
  groq: () => process.env.GROQ_API_KEY ?? '',
  mistral: () => process.env.MISTRAL_API_KEY ?? '',
  ollama: () => ''
}

async function ask(provider, model, rung) {
  const p = C.PROVIDERS[provider]
  /*
   * Thinking OFF, and this is not a tuning choice.
   *
   * The first run of this scored the VL model 0/6 with empty answers in
   * 635ms - a model already proven to read a red/blue image. NVIDIA's
   * entry sets alwaysReasons, so with a 40-token ceiling the whole budget
   * went to reasoning_content and the content came back blank. The app
   * has sent the switch for exactly this reason since the borrowed eye
   * was built; the bench did not, and was measuring its own omission.
   */
  const kwargs = C.thinkingKwargsFor(provider, false)
  const body = {
    model,
    max_tokens: 64,
    temperature: 0,
    ...(kwargs ? { chat_template_kwargs: kwargs } : {}),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: rung.ask },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png(rung.image).toString('base64')}` } }
        ]
      }
    ]
  }
  const started = Date.now()
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY[provider]()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000)
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const why = json?.error?.message ?? json?.message ?? `HTTP ${res.status}`
      return { ok: false, blind: res.status === 400 || res.status === 415, why: String(why).slice(0, 90), ms: Date.now() - started }
    }
    const said = (json?.choices?.[0]?.message?.content ?? '').trim().replace(/\s+/g, ' ')
    return { ok: rung.want.test(said), said: said.slice(0, 60), ms: Date.now() - started }
  } catch (err) {
    return { ok: false, why: err.message.slice(0, 60), ms: Date.now() - started }
  }
}

/* --------------------------------------------------------------- climb */

/** VISION_ONLY=1,4 climbs two rungs, for a model too slow to climb all six. */
const RUNGS_WANTED = (process.env.VISION_ONLY ?? '')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const LADDER = RUNGS_WANTED.length ? RUNGS.filter((r) => RUNGS_WANTED.includes(r.level)) : RUNGS

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const specs = only.length
  ? only.map((s) => {
      const [provider, ...rest] = s.split(':')
      return { provider, id: rest.join(':') }
    })
  : C.CLOUD_MODELS.map((m) => ({ provider: m.provider, id: m.id }))

const table = []
for (const { provider, id } of specs) {
  const p = C.PROVIDERS[provider]
  if (!p) {
    console.log(`${NL}=== ${provider}:${id} ===${NL}  unknown provider`)
    continue
  }
  if (!p.keyless && !KEY[provider]()) {
    console.log(`${NL}=== ${id} ===${NL}  no key`)
    continue
  }
  console.log(`${NL}=== ${id} ===`)
  let clean = 0
  let blind = false
  const times = []
  for (const rung of LADDER) {
    const tries = rung.both ? [false, true] : [false]
    let passed = 0
    const saids = []
    for (const flip of tries) {
      const built = rung.make(flip)
      const r = await ask(provider, id, built)
      times.push(r.ms)
      if (r.ok) passed++
      saids.push(r.said ?? r.why ?? '')
      if (r.blind) blind = true
      await new Promise((f) => setTimeout(f, p.minGapMs ?? 1200))
    }
    const mark = passed === tries.length ? 'pass ' : passed === 0 ? 'FAIL ' : 'half '
    if (passed === tries.length) clean++
    console.log(
      `  ${mark} ${passed}/${tries.length}  V${rung.level} ${rung.name.padEnd(44)}` +
        (SHOW || passed < tries.length ? ` said=${JSON.stringify(saids.join(' | ')).slice(0, 70)}` : '')
    )
    if (blind) break
  }
  const median = times.length ? times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)] : 0
  table.push({ id, clean, of: LADDER.length, blind, median })
  console.log(
    `  ---- ${blind ? 'cannot take an image at all' : `${clean}/${LADDER.length} rungs clean, ${median}ms median`}`
  )
}

console.log(`${NL}${'model'.padEnd(42)} rungs  median`)
for (const r of table.sort((a, b) => b.clean - a.clean || a.median - b.median)) {
  console.log(`${r.id.padEnd(42)} ${r.blind ? 'blind' : `${r.clean}/${r.of}`.padEnd(6)} ${r.blind ? '' : `${r.median}ms`}`)
}
writeFileSync('.vision-results.json', JSON.stringify(table, null, 2))
console.log(`${NL}written to .vision-results.json`)

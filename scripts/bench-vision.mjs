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

/*
 * IMPORTED FROM THE APP, NEVER COPIED.
 *
 * The glyphs, the PNG encoder and the six questions lived here first,
 * and were copied into @shared/vision when `/model check` needed to ask
 * them too. Two copies of a test is how the bench ends up measuring a
 * question the app does not ask - which this file already warns about
 * for the prompts, in those words, because it happened.
 *
 * So the drawing is gone from here and comes from there. The script and
 * the app now put the same images in front of the same models, and a
 * rung added in one place is a rung both of them climb.
 */
const V = await (async () => {
  const tmp = '.vision-shared.mjs'
  await build({
    entryPoints: ['src/shared/vision.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: tmp,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
  const mod = await import(pathToFileURL(tmp).href)
  rmSync(tmp, { force: true })
  return mod
})()

/* btoa is a browser global the shared module uses for the data URL. */
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')

const RUNGS = V.VISION_LEVELS.map((level) => ({
  level,
  both: V.bothWays(level),
  make: (flip) => {
    const t = V.visionTask(level, flip)
    return { image: t.image, ask: t.ask, want: t.want, name: t.name }
  },
  get name() {
    return V.visionTask(level, false).name
  }
}))
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
          { type: 'image_url', image_url: { url: V.dataUrl(rung.image) } }
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

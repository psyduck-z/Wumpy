/**
 * Does a cloud model write a file that actually works, and what does it cost?
 *
 * Same tasks, same system prompt and same compile check as the local bench, so
 * the numbers sit beside phi4-mini's rather than floating free. Two things are
 * measured at once because both decide whether this is worth doing:
 *
 *   correctness - did it use the write block, does the result compile, and does
 *                 the path it chose survive checkWritePath. A script that
 *                 compiles but proposes an illegal destination is still a turn
 *                 the user cannot complete.
 *   budget      - real prompt and completion token counts from the provider,
 *                 not an estimate, plus cached_tokens. The free tiers are
 *                 token-capped, so this is what decides how long a day lasts.
 *
 * Each task runs twice. The second pass is where prompt caching shows up: the
 * preamble is identical across tasks, so by round two it should be a cache hit
 * on any provider that does automatic prefix caching.
 *
 * For scale, the preamble this sends measured 1080 tokens on phi4-mini's
 * tokenizer - 905 for the system prompt, 110 for the worked examples, 65 for the
 * facts block - and it goes out on every single turn. Against a free tier capped
 * at 200k tokens a day that is most of the budget spent re-sending instructions,
 * which is why cached_tokens is reported here and not just the totals.
 *
 * Note the message order: preamble, examples, then facts. The facts block holds
 * the date and the chat title, so it is the one part that changes mid-chat;
 * putting it last keeps everything before it byte-identical and cacheable.
 *
 * On Google that reordering turns out not to matter, because nothing caches at
 * this size. Measured on gemini-3.5-flash, sending an identical prefix twice:
 *
 *     1495 tokens  ->  0 cached
 *     2775 tokens  ->  0 cached
 *     7495 tokens  ->  4076 cached
 *
 * So caching is real and is reported through the OpenAI layer, but it appears
 * to work in blocks of about 4096 tokens and a prefix shorter than one block
 * caches nothing at all. Wumpy's preamble is 1080 tokens, which is a quarter of
 * the way to the first block.
 *
 * Padding it to reach the threshold is not worth it: 4096 tokens billed at the
 * cached rate costs about what 1080 uncached costs, and only after a first call
 * that pays for all of it. Prefix caching is simply not a lever here, which is
 * the opposite of Groq, where it is the single biggest one. Any budget estimate
 * for Google should assume the preamble is paid in full on every turn.
 *
 * Both Groq and Google expose OpenAI-compatible endpoints, so one adapter
 * covers both - which is the point of the exercise.
 *
 * Measured with --limits: Groq reports its meter in headers and Google reports
 * nothing at all. Groq's own headers give 1000 requests and 8000 tokens a
 * minute, which is the first confirmation of those numbers from the provider
 * rather than from a page about the provider. Google sends no ratelimit header
 * of any kind, which is why its cap had to be found by running into it, and why
 * /usage records the request count at the moment of a refusal: on that provider
 * there is no meter to read, so the only measurement available is the crash.
 *
 * Run with:
 *   node scripts/bench-cloud.mjs --list
 *   node scripts/bench-cloud.mjs --limits groq:openai/gpt-oss-120b
 *   node scripts/bench-cloud.mjs groq:openai/gpt-oss-120b google:gemini-3-flash
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { TASKS } from './writetasks.mjs'

/* ------------------------------------------------------------------ the keys */

// Read from .env as well as the environment, because a key pasted into a file
// does not leak into shell history the way `export` does. .env is gitignored.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const PROVIDERS = {
  groq: {
    base: 'https://api.groq.com/openai/v1',
    key: () => process.env.GROQ_API_KEY,
    envName: 'GROQ_API_KEY'
  },
  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    envName: 'GEMINI_API_KEY',
    /**
     * Google keeps only the LAST system message and silently drops the rest.
     *
     * Not a 400, not a warning - the earlier ones simply never reach the model.
     * Measured: a request with system A then system B bills the same prompt
     * tokens as B alone and obeys B, and A-then-B reversed obeys A. Sending
     * Wumpy's real shape (905-token preamble, examples, 65-token facts) billed
     * 205 tokens and scored 0/6, because the only system message that survived
     * was the facts block and the model was never told the write block exists.
     *
     * So the merge is unconditional here rather than a retry after a refusal.
     * Any adapter for this provider has to do the same or the prompt vanishes.
     */
    alwaysFoldSystem: true
  },
  /**
   * The free tier that does not run out, and the one that has never been run.
   *
   * Added before a key exists on purpose. Twice now a provider's own
   * documentation has turned out to be wrong here - Groq's prefix caching does
   * not happen at this size, and Gemini Pro was reachable after being written
   * off as paid-only - so Mistral's billion tokens a month is a claim and not
   * a measurement until this says otherwise.
   */
  mistral: {
    base: 'https://api.mistral.ai/v1',
    key: () => process.env.MISTRAL_API_KEY,
    envName: 'MISTRAL_API_KEY'
  },
  /**
   * NVIDIA, which hosts the highest-scoring free model there is.
   *
   * Two things here will need measuring rather than reading. Reasoning is
   * switched through chat_template_kwargs rather than reasoning_effort, and on
   * the GLM models it is reported not to switch at all - so max_tokens is
   * generous below and the thinking column is the one to watch. And the free
   * terms are described inconsistently by NVIDIA's own staff: a credit grant
   * in one reply, rate limits with no time limit in another.
   */
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    key: () => process.env.NVIDIA_API_KEY ?? process.env.NIM_API_KEY,
    envName: 'NVIDIA_API_KEY',
    // The switch that reaches the model there. Sent on every call so the
    // thinking column means the same thing it does on the other three; the
    // models that ignore it will show it in that column.
    extraBody: { chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true } }
  }
}

/* -------------------------------------------------- Wumpy's own prompt + rules */

async function bundle(entry, name) {
  const out = join(process.cwd(), `.bc-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error'
  })
  return import(pathToFileURL(out).href)
}
const T = await bundle('src/shared/assistant.ts', 'tiers')
const W = await bundle('src/shared/writefile.ts', 'wf')

/**
 * Which prompt is being measured.
 *
 * WUMPY_PROMPT=api uses the hosted-backend prompt and drops the worked
 * examples; anything else uses the local one. The two are a real experiment,
 * not a preference: the local prompt's rules were measured into existence
 * against a 3.8B model, and whether they help or hinder a capable one is not
 * something that can be reasoned out from here.
 */
const USE_API_PROMPT = (process.env.WUMPY_PROMPT ?? 'local') === 'api'

const SYSTEM = [
  T.VOICE_PROMPT,
  T.APP_PROMPT,
  T.SHELL_PROMPT,
  T.SEARCH_PROMPT,
  T.OPEN_PROMPT,
  T.ASK_PROMPT
]
  .filter(Boolean)
  .join('\n\n')

const FACTS = [
  'Facts about right now. If the user asks about any of these, just state the answer.',
  '- Today is Thursday, 8 October 2026.',
  '- The current tier is Thinker.',
  '- This chat is titled untitled so far.',
  `- The user is on Windows. Commands run from ${homedir()}.`
].join('\n')

/** Exactly the shape a real turn has: preamble, examples, facts, question. */
function messagesFor(ask) {
  return [
    { role: 'system', content: SYSTEM },
    ...(USE_API_PROMPT ? T.API_EXAMPLES : T.shellExamples('full')),
    { role: 'system', content: FACTS },
    { role: 'user', content: ask }
  ]
}

const WRITE_ENV = { home: homedir(), cwd: homedir(), resolve, separator: sep }

/* --------------------------------------------------------------- the transport */

async function listModels(name) {
  const p = PROVIDERS[name]
  const key = p.key()
  if (!key) return { name, error: `${p.envName} is not set` }
  const res = await fetch(`${p.base}/models`, {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (!res.ok) return { name, error: `${res.status} ${(await res.text()).slice(0, 200)}` }
  const body = await res.json()
  return { name, ids: (body.data ?? []).map((m) => m.id).sort() }
}

/**
 * What the provider says is left, from its own headers, for one request.
 *
 * "How long will this last" has been answered two ways here so far and both
 * were bad. Reading the documentation gave a number that was wrong twice -
 * Groq's caching, Google's quota. Running until it refused gave a real answer
 * but spent the whole allowance to get it, and on a request-capped tier that
 * is the measurement destroying the thing being measured: finding Google's cap
 * cost eighteen of the eighteen requests.
 *
 * Most OpenAI-compatible endpoints already count it for you and return the
 * running total in headers. One two-token request reads the meter. Anything
 * matching ratelimit, quota, credit or usage is printed verbatim rather than
 * parsed into a tidy shape, because the shape differs per provider and the
 * point is to find out what this one actually sends - a provider that sends
 * nothing is itself the finding, and says that the only way left is to hit the
 * limit and let /usage record it, which is what it already does.
 */
async function readLimits(provider, model) {
  const p = PROVIDERS[provider]
  let res
  try {
    res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key()}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say ok.' }],
        max_tokens: 2048,
        ...(p.extraBody ?? {})
      })
    })
  } catch (err) {
    return { error: `could not reach it: ${err.message}` }
  }

  const headers = [...res.headers.entries()]
    .filter(([k]) => /ratelimit|rate-limit|quota|credit|usage|remaining|reset|retry/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b))

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = JSON.stringify(body ?? {}).slice(0, 300)
    return { error: `${res.status} ${detail}`, headers }
  }

  // What one real Wumpy question costs, against whatever the headers just said
  // is left. A question averages about 2.5 calls: ask, feed the output back,
  // and often one more.
  const used = body?.usage?.total_tokens ?? 0
  const spend = used
    ? `one 2-token call billed ${used} total tokens ` +
      `(${body?.usage?.prompt_tokens ?? '?'} in, ${body?.usage?.completion_tokens ?? '?'} out` +
      `${used > (body?.usage?.prompt_tokens ?? 0) + (body?.usage?.completion_tokens ?? 0) ? ', rest is thinking' : ''})`
    : ''
  return { headers, spend }
}

/**
 * Folds the message list into the shape a stricter endpoint will accept.
 *
 * Google's OpenAI-compatible layer is less forgiving than Groq's: it does not
 * reliably take a second `system` message partway down the list, which is
 * exactly what Wumpy sends (preamble, examples, then the live facts). Merging
 * them changes what is measured, so it is only done after a request is refused,
 * and the fallback is reported rather than hidden - if a provider needs the
 * facts block welded to the preamble, that is a real constraint on the caching
 * design and not a detail of this script.
 */
function fold(messages) {
  const systems = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const rest = messages.filter((m) => m.role !== 'system')
  return [{ role: 'system', content: systems.join('\n\n') }, ...rest]
}

const quirks = {
  noStreamOptions: new Set(),
  foldSystem: new Set(
    Object.entries(PROVIDERS)
      .filter(([, p]) => p.alwaysFoldSystem)
      .map(([name]) => name)
  )
}

/**
 * Keeps requests under the per-minute ceiling, and waits out the ones that slip.
 *
 * Google's free tier allows 10 requests a minute. Fired back to back, a bench
 * trips that in seconds and the 429s look exactly like a daily quota being
 * exhausted - which is how the first run of this was misread. Pacing removes
 * the ambiguity: a 429 that survives a paced retry is a real daily cap.
 *
 * Both halves are what a provider adapter needs too, so the shape is the point
 * and not just a benchmark convenience.
 */
const MIN_GAP_MS = { google: 7000, groq: 2100, mistral: 1200, nvidia: 1700 }
let lastRequestAt = 0

async function pace(provider) {
  const gap = MIN_GAP_MS[provider] ?? 0
  const wait = lastRequestAt + gap - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

/**
 * How long to wait before trying again, or zero to give up.
 *
 * 503 means the model is busy and 429 means slow down, and both are worth one
 * wait - but only if the wait is short. Google answers an exhausted daily quota
 * with the same 429 and a retryDelay of 65304s, which is to say eighteen hours.
 * Honouring that literally is how this bench came to sit and sleep until
 * tomorrow. Anything past a couple of minutes is a cap, not congestion, so it
 * is reported as one rather than waited out.
 */
const GIVE_UP_AFTER_MS = 120_000

function retryAfterMs(status, attempt, detail) {
  if (status !== 429 && status !== 503) return 0
  const asked = /"retryDelay":\s*"(\d+)s"/.exec(detail ?? '')
  const ms = asked ? Number(asked[1]) * 1000 + 500 : Math.min(60_000, 8000 * 2 ** attempt)
  return ms > GIVE_UP_AFTER_MS ? 0 : ms
}

async function chat(provider, model, messages) {
  const p = PROVIDERS[provider]
  /**
   * Set after the pacing and backoff waits, not before.
   *
   * It started before them, and a task that happened to land behind a 58s
   * throttle reported 62.3s to first token - a number that says nothing about
   * the provider and everything about this script's own queue. The clock now
   * starts when the attempt that actually streams goes out.
   */
  let started = Date.now()
  let firstToken = 0

  async function send(body) {
    return fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.key()}`
      },
      body: JSON.stringify(body)
    })
  }

  const bodyFor = () => ({
    model,
    messages: quirks.foldSystem.has(provider) ? fold(messages) : messages,
    stream: true,
    ...(quirks.noStreamOptions.has(provider) ? {} : { stream_options: { include_usage: true } }),
    temperature: 0.2,
    max_tokens: 2000,
    ...(p.extraBody ?? {})
  })

  await pace(provider)
  started = Date.now()
  let res = await send(bodyFor())

  // Back off and try again while the provider is asking us to.
  for (let attempt = 0; attempt < 3 && (res.status === 429 || res.status === 503); attempt++) {
    const detail = await res.text()
    const waitMs = retryAfterMs(res.status, attempt, detail)
    if (!waitMs) {
      const asked = /"retryDelay":\s*"(\d+)s"/.exec(detail)
      const hours = asked ? (Number(asked[1]) / 3600).toFixed(1) : '?'
      throw new Error(
        `${res.status} quota exhausted for ${model} - it asks for ${hours}h, which is a daily cap`
      )
    }
    console.log(`        (${res.status}, waiting ${Math.round(waitMs / 1000)}s)`)
    await new Promise((r) => setTimeout(r, waitMs))
    await pace(provider)
    started = Date.now()
    res = await send(bodyFor())
  }

  // Two refusals are worth adapting to rather than failing on, because both are
  // shape complaints and not capability ones. Each is remembered, so the cost is
  // one wasted request per provider rather than one per task.
  if (res.status === 400) {
    const detail = await res.text()
    if (/stream_options/i.test(detail) && !quirks.noStreamOptions.has(provider)) {
      quirks.noStreamOptions.add(provider)
      console.log(`        (${provider} rejects stream_options; token counts may be absent)`)
      res = await send(bodyFor())
    } else if (!quirks.foldSystem.has(provider)) {
      quirks.foldSystem.add(provider)
      console.log(`        (${provider} rejects a second system message; merging the facts block)`)
      res = await send(bodyFor())
    } else {
      throw new Error(`400 ${detail.slice(0, 300)}`)
    }
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)

  let text = ''
  let usage = null
  let buffer = ''
  /**
   * Why the model stopped, which "no block" on its own cannot tell you.
   *
   * GLM-5.3 scored 1/8 here and the eight lines all read the same. They were
   * not the same failure: it averages 1,978 output tokens against a 2,000 cap,
   * so the reasoning ate the budget and the answer was cut off before the
   * block. That is a budget defect, fixable by giving it room. A model that
   * finishes cleanly and still writes no block has a capability defect, which
   * is not fixable at all. Reporting both as "no block" hid the difference.
   */
  let finish = ''
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let obj
      try {
        obj = JSON.parse(payload)
      } catch {
        continue
      }
      if (obj.usage) usage = obj.usage
      if (obj.choices?.[0]?.finish_reason) finish = obj.choices[0].finish_reason
      const delta = obj.choices?.[0]?.delta?.content
      if (delta) {
        if (!firstToken) firstToken = Date.now()
        text += delta
      }
    }
  }

  const out = usage?.completion_tokens ?? 0
  const prompt = usage?.prompt_tokens ?? 0
  /**
   * Thinking tokens are in neither prompt_tokens nor completion_tokens.
   *
   * Measured on gemini-3.5-flash: a reply of "Ok" came back as 3 prompt and 1
   * completion, with total_tokens 78. The other 74 were reasoning, invisible in
   * both halves and billed all the same. So total is what the budget is spent
   * against, and prompt + completion would have understated this call by 20x.
   */
  const total = usage?.total_tokens ?? prompt + out
  return {
    text,
    finish,
    seconds: (Date.now() - started) / 1000,
    ttft: firstToken ? (firstToken - started) / 1000 : 0,
    promptTokens: prompt,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outTokens: out,
    thinkTokens: Math.max(0, total - prompt - out),
    totalTokens: total,
    // Generation rate over the streaming window only, so the network round trip
    // to the first token is not counted as slow generation.
    tokPerSec: firstToken && out ? out / Math.max(0.001, (Date.now() - firstToken) / 1000) : 0
  }
}

/* ----------------------------------------------------------------- the scoring */

function score(task, text) {
  const block = /```wumpy-write\n([\s\S]*?)```/.exec(text)
  if (!block) return { usedBlock: false }
  const req = W.readWriteRequest(block[1])
  const check = W.checkWritePath(req.path ?? '', WRITE_ENV)

  const dir = mkdtempSync(join(tmpdir(), 'wumpy-bc-'))
  const file = join(dir, 'candidate.py')
  writeFileSync(file, req.content, 'utf8')
  const compiled = spawnSync('python', ['-I', '-m', 'py_compile', file], {
    encoding: 'utf8'
  })
  const compiles = compiled.status === 0

  return {
    usedBlock: true,
    compiles,
    pathOk: check.ok,
    pathWhy: check.why,
    path: req.path,
    onTask: compiles && task.wants.every((w) => req.content.includes(w)),
    lines: req.content.split('\n').length,
    stderr: (compiled.stderr || '').trim().split('\n').slice(-2)[0] ?? ''
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)

/* -------------------------------------------------------------------- the runs */

const args = process.argv.slice(2)

/**
 * Listing and measuring are separate runs rather than one falling through to
 * the other. The listing branch used to end in process.exit, which tears libuv
 * down while fetch's keep-alive socket is still open and trips an assertion on
 * Windows - after the output, so it looked like a crash that had printed fine.
 */
const limiting = args.includes('--limits')
const listing = !limiting && (args.includes('--list') || args.length === 0)

if (listing) {
  for (const name of Object.keys(PROVIDERS)) {
    const r = await listModels(name)
    console.log(`\n=== ${name} ===`)
    if (r.error) console.log(`  ${r.error}`)
    else r.ids.forEach((id) => console.log(`  ${id}`))
  }
}

if (limiting) {
  for (const spec of args.filter((a) => a !== '--limits')) {
    const [provider, ...rest] = spec.split(':')
    const model = rest.join(':')
    console.log(`\n=== ${spec} ===`)
    if (!PROVIDERS[provider]) {
      console.log(`  unknown provider "${provider}"`)
      continue
    }
    if (!PROVIDERS[provider].key()) {
      console.log(`  ${PROVIDERS[provider].envName} is not set`)
      continue
    }
    const r = await readLimits(provider, model)
    if (r.error) console.log(`  ${r.error}`)
    if (!r.headers?.length) {
      console.log('  this provider reports no limit headers — the only way to')
      console.log('  learn its cap is to hit it, which /usage records when it happens')
    }
    for (const [k, v] of r.headers ?? []) console.log(`  ${k.padEnd(38)} ${v}`)
    if (r.spend) console.log(`\n  ${r.spend}`)
  }
}

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 2)

// --limits is a reading, not a run: it must not fall through into the measuring
// loop, which would take the flag itself for a provider spec and then spend the
// allowance the reading exists to avoid spending.
for (const spec of listing || limiting ? [] : args) {
  const [provider, ...rest] = spec.split(':')
  const model = rest.join(':')
  if (!PROVIDERS[provider]) {
    console.log(`\n=== ${spec} ===\n  unknown provider "${provider}"`)
    continue
  }
  if (!PROVIDERS[provider].key()) {
    console.log(`\n=== ${spec} ===\n  ${PROVIDERS[provider].envName} is not set`)
    continue
  }

  console.log(`\n=== ${spec} ===`)
  const tally = { block: 0, compiles: 0, onTask: 0, pathOk: 0, truncated: 0, n: 0 }
  const rates = []
  const ttfts = []
  let promptTotal = 0
  let cachedTotal = 0
  let outTotal = 0
  let thinkTotal = 0
  let billedTotal = 0
  let failed = 0

  for (let round = 1; round <= ROUNDS; round++) {
    for (const task of TASKS) {
      let got
      try {
        got = await chat(provider, model, messagesFor(task.ask))
      } catch (err) {
        failed++
        console.log(`  r${round} ERROR     ${String(err.message).slice(0, 110)}`)
        continue
      }
      promptTotal += got.promptTokens
      cachedTotal += got.cached
      outTotal += got.outTokens
      thinkTotal += got.thinkTokens
      billedTotal += got.totalTokens - got.cached
      if (got.tokPerSec) rates.push(got.tokPerSec)
      if (got.ttft) ttfts.push(got.ttft)

      const s = score(task, got.text)
      tally.n++
      if (!s.usedBlock) {
        // "truncated" means it never got to the block, not that it cannot
        // write one - a different defect with a different fix.
        const why = got.finish === 'length' ? 'truncated' : 'no block '
        tally.truncated += got.finish === 'length' ? 1 : 0
        console.log(`  r${round} ${why} ${task.ask.slice(0, 40)}...`)
        continue
      }
      tally.block++
      if (s.compiles) tally.compiles++
      if (s.onTask) tally.onTask++
      if (s.pathOk) tally.pathOk++

      console.log(
        `  r${round} ${s.compiles ? 'compiles' : 'SYNTAX  '} ${s.onTask ? 'on-task' : 'thin   '} ` +
          `${s.pathOk ? 'path-ok' : 'PATH   '} ${String(s.lines).padStart(3)}ln ` +
          `${got.promptTokens}in${got.cached ? `/${got.cached}cached` : ''} ${got.outTokens}out` +
          `${got.thinkTokens ? `+${got.thinkTokens}think` : ''} ` +
          `${got.ttft.toFixed(1)}s+${got.tokPerSec.toFixed(0)}t/s  ${task.ask.slice(0, 24)}...`
      )
      if (!s.compiles) console.log(`        ${s.stderr}`)
      if (!s.pathOk) console.log(`        path "${s.path}" -> ${s.pathWhy}`)
    }
  }

  const calls = tally.n || 1
  console.log(
    `\n  correctness  ${tally.block}/${tally.n} block, ${tally.compiles}/${tally.n} compile, ` +
      `${tally.onTask}/${tally.n} on task, ${tally.pathOk}/${tally.n} legal path` +
      (failed ? `, ${failed} request errors` : '') +
      // Separated because they are different problems. Truncated means the
      // output cap was too small for how much the model reasons, which is a
      // setting. A plain miss means it will not write the block, which is not.
      (tally.truncated ? `  (${tally.truncated} of the misses were truncation, not format)` : '')
  )
  console.log(
    `  speed        ${median(ttfts).toFixed(2)}s to first token, ${median(rates).toFixed(0)} tok/s`
  )
  console.log(
    `  tokens/call  ${Math.round(promptTotal / calls)} in ` +
      `(${Math.round(cachedTotal / calls)} cached), ${Math.round(outTotal / calls)} out, ` +
      `${Math.round(thinkTotal / calls)} thinking -> ${Math.round(billedTotal / calls)} billed`
  )

  // What the free tier actually buys, from the numbers just measured. A Wumpy
  // question averages about 2.5 calls: ask, feed the command output back, and
  // often one more.
  const billed = billedTotal / calls
  if (billed > 0) {
    const caps =
      provider === 'groq'
        ? { tpd: 200_000, tpm: 8_000, rpm: 30, label: '200k tok/day, 8k tok/min, 30 rpm' }
        : provider === 'mistral'
          ? // A billion a month is ~33M a day, which is the figure to compare
            // against Groq's 200k. Stated by Mistral, not measured here.
            { tpd: 33_000_000, tpm: 500_000, rpm: 60, label: '~1B tok/month, 500k tok/min, 1 rps' }
          : provider === 'nvidia'
            ? // No published daily token cap, so the rate limit is the whole
              // story - unless the credit grant some accounts still have is.
              { tpd: 0, tpm: 0, rpm: 40, label: 'no published daily cap, 40 rpm' }
            : { tpd: 0, tpm: 250_000, rpm: 10, label: '250k tok/min, 10 rpm, request-capped' }
    const perQuestion = billed * 2.5
    const byTokens = caps.tpd ? Math.floor(caps.tpd / perQuestion) : Infinity
    const byRate = Math.floor((caps.rpm * 60) / 2.5)
    console.log(
      `  free tier    ${caps.label}; ` +
        `${Math.round(perQuestion)} tokens per question ` +
        `(a question averages 2.5 calls)`
    )
    console.log(
      `               ` +
        (caps.tpd ? `${byTokens} questions/day on tokens; ` : 'no daily token cap; ') +
        `${byRate} questions/min on the rate limit`
    )
  }
}

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
 * putting it last keeps everything before it byte-identical and cacheable. That
 * is the opposite of what the main process currently does, and whether it
 * matters is exactly what the round-two cached figure answers.
 *
 * Both Groq and Google expose OpenAI-compatible endpoints, so one adapter
 * covers both - which is the point of the exercise.
 *
 * Run with:
 *   node scripts/bench-cloud.mjs --list
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
const T = await bundle('src/shared/tiers.ts', 'tiers')
const W = await bundle('src/shared/writefile.ts', 'wf')

const SYSTEM = [
  T.TIERS.thinker.systemPrompt,
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
    ...T.shellExamples('full'),
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
const MIN_GAP_MS = { google: 7000, groq: 2100 }
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
    max_tokens: 2000
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
const listing = args.includes('--list') || args.length === 0

if (listing) {
  for (const name of Object.keys(PROVIDERS)) {
    const r = await listModels(name)
    console.log(`\n=== ${name} ===`)
    if (r.error) console.log(`  ${r.error}`)
    else r.ids.forEach((id) => console.log(`  ${id}`))
  }
}

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 2)

for (const spec of listing ? [] : args) {
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
  const tally = { block: 0, compiles: 0, onTask: 0, pathOk: 0, n: 0 }
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
        console.log(`  r${round} no block  ${task.ask.slice(0, 40)}...`)
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
      (failed ? `, ${failed} request errors` : '')
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

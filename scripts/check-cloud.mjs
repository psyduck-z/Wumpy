/**
 * The hosted-model rules, checked without a network or a key.
 *
 * Three of the four quirks this guards against fail silently against the live
 * API: the prompt disappears, the bill is understated, the retry sleeps until
 * tomorrow. None of them raises anything, so none of them would be noticed by a
 * test that only asked whether a call succeeded. They are checked here as
 * properties of pure functions instead.
 *
 * Run with: node scripts/check-cloud.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const out = join(process.cwd(), '.cloud-check.mjs')
await build({
  entryPoints: ['src/shared/cloud.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const C = await import(pathToFileURL(out).href)

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  const shown = JSON.stringify(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}`
  )
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* ------------------------------------------------------------------ routing */

check('a Gemini model routes to Google', C.providerFor('gemini-3.5-flash'), 'google')
check('including one not in the catalogue', C.providerFor('gemini-9-ultra'), 'google')
check('the models/ prefix the API returns', C.providerFor('models/gemini-3.8-flash'), 'google')
check('a gpt-oss model routes to Groq', C.providerFor('openai/gpt-oss-120b'), 'groq')
check('as does Kimi on Groq', C.providerFor('moonshotai/kimi-k2-instruct-0905'), 'groq')
check('an Ollama model is not cloud', C.providerFor('qwen2.5-coder:14b'), null)
check('nor is one with a dash and a tag', C.providerFor('phi4-mini:3.8b'), null)
check('nor is an empty name', C.providerFor(''), null)
check('isCloudModel agrees', C.isCloudModel('phi4-mini:3.8b'), false)
check('and the other way', C.isCloudModel('gemini-3.5-flash'), true)

/* ------------------------------------------------- the silently deleted prompt */

// The failure this exists to prevent: Google keeps only the LAST system message
// and drops the rest without a word. Wumpy sends three.
const real = [
  { role: 'system', content: 'PREAMBLE' },
  { role: 'user', content: 'example question' },
  { role: 'assistant', content: 'example answer' },
  { role: 'system', content: 'FACTS' },
  { role: 'user', content: 'the real question' }
]

const folded = C.foldSystemMessages(real)
check('folding leaves one system message', folded.filter((m) => m.role === 'system').length, 1)
check('and it is first', folded[0].role, 'system')
check('the preamble survives', folded[0].content.includes('PREAMBLE'), true)
check('and so do the facts', folded[0].content.includes('FACTS'), true)
check(
  'in that order',
  folded[0].content.indexOf('PREAMBLE') < folded[0].content.indexOf('FACTS'),
  true
)
check('nothing else is lost', folded.length, 4)
check('the examples keep their order', [folded[1].role, folded[2].role], ['user', 'assistant'])
check('and the question stays last', folded[3].content, 'the real question')

check('one system message is left alone', C.foldSystemMessages([real[0], real[4]]).length, 2)
check('and none at all is fine', C.foldSystemMessages([real[4]]).length, 1)
check(
  'an empty system part is dropped, not joined',
  C.foldSystemMessages([
    { role: 'system', content: 'A' },
    { role: 'system', content: '   ' },
    { role: 'user', content: 'q' }
  ])[0].content,
  'A'
)

check('Google folds', C.wireMessagesFor('google', real).length, 4)
check('Groq does not, since it honours them all', C.wireMessagesFor('groq', real).length, 5)
check('folding does not mutate the input', real.length, 5)

/* ------------------------------------------------------- the invisible tokens */

// Measured on gemini-3.5-flash: "Ok" came back as 3 prompt, 1 completion,
// total 78. The other 74 were reasoning - billed, and in neither field.
const ok = C.countTokens({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 78 })
check('thinking is recovered from the total', ok.thinking, 74)
check('and is what makes the bill', ok.billed, 78)
check('prompt + completion would have said 4', ok.prompt + ok.completion, 4)

const cached = C.countTokens({
  prompt_tokens: 7495,
  completion_tokens: 2,
  total_tokens: 7531,
  prompt_tokens_details: { cached_tokens: 4076 }
})
check('cached tokens come off the bill', cached.billed, 7531 - 4076)
check('and are reported separately', cached.cached, 4076)
check(
  'a missing total falls back to the parts',
  C.countTokens({ prompt_tokens: 10, completion_tokens: 5 }).billed,
  15
)
check('no usage at all is zero, not NaN', C.countTokens(null).billed, 0)
check(
  'and never negative',
  C.countTokens({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 2 }).thinking,
  0
)

/* ------------------------------------------------------ the two kinds of 429 */

// gemini-3.8-flash answered an exhausted day with retryDelay 65304s.
const day = C.classifyLimit(429, '{"error":{"code":429},"retryDelay":"65304s"}', 'gemini-3.8-flash')
check('eighteen hours is a cap, not a wait', day.kind, 'exhausted')
check('so nothing is slept', day.waitMs, 0)
check('and the message names the model', day.message.includes('gemini-3.8-flash'), true)
check('and says when it comes back', day.message.includes('18h'), true)

// This verdict was observably wrong once: gemini-3.5-flash was told its day was
// over and answered normally forty minutes later. A delay of minutes is a limit
// that clears; only hours mean the day.
const middling = C.classifyLimit(429, '{"retryDelay":"600s"}', 'gemini-3.5-flash')
check('ten minutes is not the day being over', middling.kind, 'throttle')
check('but is too long to sit and wait for', middling.waitMs, 0)
check('and does not claim tomorrow', middling.message.includes('today'), false)
check(
  'four hours is where the day begins',
  C.classifyLimit(429, '{"retryDelay":"14400s"}', 'x').kind,
  'exhausted'
)
check('just under it is not', C.classifyLimit(429, '{"retryDelay":"14000s"}', 'x').kind, 'throttle')

const brief = C.classifyLimit(429, '{"retryDelay":"58s"}', 'gemini-3.5-flash')
check('a short delay is a throttle', brief.kind, 'throttle')
check('and is honoured', brief.waitMs, 58_500)

const noDelay = C.classifyLimit(429, '{"error":{"code":429}}', 'x')
check('a 429 with no delay still waits', noDelay.kind, 'throttle')
check('for something sensible', noDelay.waitMs > 0 && noDelay.waitMs <= C.GIVE_UP_AFTER_MS, true)

const busy = C.classifyLimit(503, 'high demand', 'x')
check('503 is the provider being busy', busy.kind, 'busy')
check('and is capped, not honoured blindly', busy.waitMs <= C.GIVE_UP_AFTER_MS, true)

check('a 500 is not a rate limit', C.classifyLimit(500, '', 'x').kind, 'other')
check('nor is a 200', C.classifyLimit(200, '', 'x').kind, 'other')
check('the give-up threshold is two minutes', C.GIVE_UP_AFTER_MS, 120_000)

/* ---------------------------------------------------------------- the key itself */

check(
  'a Google AQ. key is accepted',
  C.looksLikeKey('google', 'AQ.Ab8RN6IG1mx2UYRpbYZptwAod2I06QoJ').ok,
  true
)
check(
  'so is the older AIza form',
  C.looksLikeKey('google', 'AIzaSyC-1234567890abcdefghijklmn').ok,
  true
)
check(
  'a Groq key must start gsk_',
  C.looksLikeKey('groq', 'gsk_1234567890abcdefghijklmnop').ok,
  true
)
check(
  'and is refused when it does not',
  C.looksLikeKey('groq', 'AIzaSyC-1234567890abcdefghij').ok,
  false
)
check('a truncated paste is caught', C.looksLikeKey('google', 'AQ.Ab8RN').ok, false)
check(
  'a URL is not a key',
  C.looksLikeKey('google', 'https://aistudio.google.com/apikey').ok,
  false
)
check(
  'nor is one with Bearer on the front',
  C.looksLikeKey('google', 'Bearer AQ.Ab8RN6IG1mx2UYRpbYZptw').ok,
  false
)
check(
  'a key with a space in it is refused',
  C.looksLikeKey('google', 'AQ.Ab8RN6IG1 mx2UYRpbYZptw').ok,
  false
)
check('an empty key is refused', C.looksLikeKey('google', '').ok, false)
check(
  'every refusal explains itself',
  ['', 'Bearer x', 'https://x', 'short'].every((k) => {
    const r = C.looksLikeKey('google', k)
    return !r.ok && r.why.length > 10
  }),
  true
)

check(
  'a masked key shows only the ends',
  C.maskKey('AQ.Ab8RN6IG1mx2UYRpbYZptwAod2I06QoJ'),
  'AQ.A…6QoJ'
)
check('and a short one shows nothing', C.maskKey('abc'), '••••')
check('masking an empty key does not crash', C.maskKey(''), '••••')

/* ------------------------------------------------------------- what is recorded */

check('Google is marked as needing the fold', C.PROVIDERS.google.foldSystem, true)
check('Groq is not', C.PROVIDERS.groq.foldSystem, false)
check('Google caches only in 4096-token blocks', C.PROVIDERS.google.cacheBlockTokens, 4096)
check('so a 1080-token preamble caches nothing', 1080 >= C.PROVIDERS.google.cacheBlockTokens, false)
check('Groq has no such floor', C.PROVIDERS.groq.cacheBlockTokens, 0)
check('pacing keeps Google under 10 a minute', C.PROVIDERS.google.minGapMs * 10 >= 60_000, true)
check('and Groq under 30', C.PROVIDERS.groq.minGapMs * 30 >= 60_000, true)
check(
  'every catalogue model routes to its provider',
  C.CLOUD_MODELS.every((m) => C.providerFor(m.id) === m.provider),
  true
)
check(
  'and the 25-a-day one says so',
  C.CLOUD_MODELS.find((m) => m.id === 'gemini-3.8-flash').blurb.includes('25'),
  true
)

/* ------------------------------------------------------- the billed thinking */

// Measured on gemini-3.5-flash: one sentence, max_tokens 200, came back as 188
// thinking tokens and 8 of prose, truncated mid-word with finish_reason
// "length". With reasoning off: 0 thinking, 31 tokens, complete.
check('Google thinking-off is none', C.reasoningEffortFor('google', false), 'none')
// Groq's gpt-oss takes only low/medium/high. Sending 'none' would 400 every turn.
check(
  'Groq thinking-off is low, since none is not a value',
  C.reasoningEffortFor('groq', false),
  'low'
)
check('thinking-on omits the field on Google', C.reasoningEffortFor('google', true), null)
check('and on Groq', C.reasoningEffortFor('groq', true), null)

check('with reasoning off the cap is the tier’s own', C.maxTokensFor(384, false), 384)
check(
  'with it on there is room to think first',
  C.maxTokensFor(384, true),
  384 + C.THINKING_ALLOWANCE
)
check('the allowance clears the measured 487', C.THINKING_ALLOWANCE > 487, true)
check('a zero cap does not become zero tokens', C.maxTokensFor(0, false) > 0, true)
check(
  'every tier’s num_predict survives reasoning being on',
  [384, 800, 1024, 1500].every((n) => C.maxTokensFor(n, true) - C.THINKING_ALLOWANCE === n),
  true
)

/* ------------------------------------------------- the key never comes back */

/**
 * These read the source rather than exercise the API, because what is being
 * checked is the absence of a path.
 *
 * Calling the interface can only show that the ways it knows about are closed.
 * Reading it shows that no handler, bridge or history write exists to open
 * one - and each of these has a plausible-looking change that would quietly
 * undo it: a convenience getter so a settings page can show the key, a
 * "remember what I typed" that forgets to make an exception.
 */
const read = (f) => readFileSync(f, 'utf8')
const preload = read('src/preload/index.ts')
const main = read('src/main/index.ts')
const keystore = read('src/main/keys.ts')
const inputHistory = read('src/renderer/src/hooks/useInputHistory.ts')
const keysBridge = /keys:\s*\{[\s\S]*?\n  \},/.exec(preload)?.[0] ?? ''

check('the renderer can ask which providers are set', keysBridge.includes('status:'), true)
check('it can set a key', keysBridge.includes('set:'), true)
check('and clear one', keysBridge.includes('clear:'), true)
check('but no bridge returns a key', /\bget:|\bread:|\breveal:|secret/.test(keysBridge), false)
check('and the word secret never reaches preload', preload.includes('secret('), false)
check('the main process exposes no key getter', /IPC\.keyGet|'key:get'/.test(main), false)
check('the key file is encrypted', keystore.includes('safeStorage.encryptString'), true)
check(
  'nothing is stored when it cannot be',
  keystore.includes('if (!this.available()) return this.cache'),
  true
)

check(
  'a /key line is kept out of input history',
  /\/\^\\\/\(key\|apikey\)/.test(inputHistory),
  true
)
check(
  'and it returns before anything is recorded',
  (() => {
    const body = /const push = useCallback[\s\S]*?\n  \}, \[\]\)/.exec(inputHistory)?.[0] ?? ''
    const guard = body.indexOf('key|apikey')
    const write = body.indexOf('history.add')
    return guard !== -1 && write !== -1 && guard < write
  })(),
  true
)

check('errors strip anything key-shaped', read('src/main/cloud.ts').includes('stripKey('), true)
check(
  'titles and compaction stay on an installed local model',
  /function backgroundModel[\s\S]*?installedModels\.includes/.test(main),
  true
)
check(
  'nothing in the background path resolves a cloud tier',
  /backgroundModel\(\)[\s\S]{0,200}resolveTierModel/.test(main),
  false
)
check('the chat path picks a client by model', main.includes('clientFor(model).chat'), true)
check(
  'warming is skipped for a hosted model',
  /if \(isCloudModel\(model\)\) return/.test(main),
  true
)
check(
  'aborting reaches both clients',
  /ollama\.abort\(requestId\)[\s\S]{0,80}cloud\.abort\(requestId\)/.test(main),
  true
)

console.log(failures ? `\n${failures} cloud checks FAILED` : '\nall cloud checks')
process.exitCode = failures ? 1 : 0

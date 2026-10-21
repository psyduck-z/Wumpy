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

/** Source is read in several places below; declared here so all of them can. */
const read = (f) => readFileSync(f, 'utf8')

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
/*
 * A LOCAL OLLAMA MODEL IS ADDRESSABLE AS OF 21 OCT, and these three
 * asserted the opposite.
 *
 * The rule was `-cloud` only, because "a plain phi4-mini:3.8b is a model
 * on this laptop, and Wumpy has had no local client since it went
 * cloud-only". Both halves were wrong: Ollama's OpenAI endpoint serves
 * local and cloud at the same URL - the one gemma4:31b-cloud has been
 * using all along - so there is nothing extra to build.
 *
 * `isCloudModel` is the odd name now and only decides whether the chosen
 * model is one the app can reach, which a local one is.
 */
check('a local Ollama model routes to the daemon', C.providerFor('qwen2.5-coder:14b'), 'ollama')
check('including one with a dash and a tag', C.providerFor('phi4-mini:3.8b'), 'ollama')
check('nor is an empty name', C.providerFor(''), null)
check('and it counts as reachable', C.isCloudModel('phi4-mini:3.8b'), true)
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
check('and says how long it asked for', day.message.includes('18h'), true)
// Observed twice: a model asking for 18h answered normally 40 minutes later.
// Nothing here can tell a spent day from a long throttle, so it must not say
// it can.
check('without asserting the day is gone', /used up|exhausted for today/.test(day.message), false)
check('and it hedges', day.message.includes('often clears much sooner'), true)

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

/*
 * A 500 is not a rate limit, which is what this always meant - 'other' was
 * simply the only verdict available that was not one. It is 'busy' now,
 * and the distinction that matters is preserved and worth stating: busy
 * does NOT rest a key, where throttle and exhausted both do. A gateway
 * blip must not take a working key out of the rotation.
 */
{
  const five = C.classifyLimit(500, '', 'x')
  check('a 500 is not a rate limit', five.kind !== 'throttle' && five.kind !== 'exhausted', true)
  check('it is the provider being busy', five.kind, 'busy')
}
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
// Groq's docs say caching is automatic, free and exempt from the rate limit
// on the gpt-oss models. Measured, it does not appear: eight calls sharing a
// 2118-token prefix all reported 0 cached, and a back-to-back test with an
// identical 6578-token prefix came back with prompt_tokens_details absent
// entirely. Zero here records what was seen, not what was promised.
check('Groq caching is not planned around', C.PROVIDERS.groq.cacheBlockTokens, 0)

/**
 * Mistral is the one where caching finally turned up.
 *
 * Same benchmark, same preamble, a real key: five of eight calls reported
 * 2101in/2048cached, and the run averaged 1,024 cached tokens a call - 1,277
 * billed against 2,301 uncached. That is the first time prompt caching has
 * been observed on any provider here, after Groq promised it and showed 0 and
 * Google turned out to need a whole 4,096-token block.
 *
 * The number that matters is that it is BELOW the preamble, which is what
 * decides whether keeping the prefix byte-identical is worth anything. On
 * Google it is above and the discipline buys nothing.
 */
check('Mistral caches at 2048', C.PROVIDERS.mistral.cacheBlockTokens, 2048)
check(
  'which is below the preamble, so the prefix matters there',
  2106 >= C.PROVIDERS.mistral.cacheBlockTokens,
  true
)
check('unlike Google, where it is above it', 2106 >= C.PROVIDERS.google.cacheBlockTokens, false)

// 8,000 tokens a minute is the ceiling that actually bites on Groq: a turn
// at Wumpy's preamble size is most of three thousand, so three fill a minute.
check('Groq is paced on tokens', C.PROVIDERS.groq.tokensPerMinute, 8000)
check('Google is paced on requests instead', C.PROVIDERS.google.tokensPerMinute, 0)

/* ------------------------------ the free tier that does not run out */

// A billion tokens a month, against Groq's 200,000 a day and Google's
// eighteen requests. At Wumpy's measured 2,858 tokens a call that is roughly
// 350,000 calls a month, which is not a number anyone types.
check('Mistral is a provider', Boolean(C.PROVIDERS.mistral), true)
check('with an OpenAI-compatible base', C.PROVIDERS.mistral.base, 'https://api.mistral.ai/v1')
check('one request a second, with margin', C.PROVIDERS.mistral.minGapMs >= 1000, true)
check('and 500k tokens a minute', C.PROVIDERS.mistral.tokensPerMinute, 500_000)
// Most of the Mistral line does not take reasoning_effort at all, and an
// unknown parameter there is a 400 rather than something quietly ignored. The
// exception is Medium 3.5, which Mistral's changelog introduces with
// "adjustable reasoning via the reasoning_effort parameter" - and which is the
// model this app points at first, so the field has to reach it.
check(
  'nothing is sent to Large',
  C.reasoningEffortFor('mistral', false, 'mistral-large-latest'),
  null
)
check('nor to Codestral', C.reasoningEffortFor('mistral', false, 'codestral-latest'), null)
check('nor to Small', C.reasoningEffortFor('mistral', false, 'mistral-small-latest'), null)
check(
  'but Medium 3.5 takes it',
  C.reasoningEffortFor('mistral', false, 'mistral-medium-latest'),
  'low'
)
check('under its dated id too', C.reasoningEffortFor('mistral', false, 'mistral-medium-3-5'), 'low')
// The alias moves; the family does not. A future Medium should keep the field
// rather than silently lose it the day the number changes.
check('and a later Medium', C.reasoningEffortFor('mistral', false, 'mistral-medium-4'), 'low')
// Medium 3 came before the parameter existed, so it must not be sent one.
check('but not Medium 3', C.reasoningEffortFor('mistral', false, 'mistral-medium-3'), null)
check(
  'a tier that wants reasoning still omits it',
  C.reasoningEffortFor('mistral', true, 'mistral-medium-latest'),
  null
)
check('unlike Google', C.reasoningEffortFor('google', false), 'none')

check('a mistral model routes there', C.providerFor('mistral-large-latest'), 'mistral')
check('so does codestral', C.providerFor('codestral-latest'), 'mistral')
check('and devstral', C.providerFor('devstral-small-latest'), 'mistral')
// NVIDIA hosts mixtral under a vendor prefix, and it starts with the letters
// "mistral". Routed by the bare-name rule it would reach api.mistral.ai, which
// has never heard of that id.
check(
  'but mistralai/ belongs to NVIDIA',
  C.providerFor('mistralai/mixtral-8x7b-instruct'),
  'nvidia'
)
/**
 * The ORDER lists still name Mistral and NVIDIA models, but the catalogue
 * is the authority on what exists - so a model the app no longer ships has
 * nowhere to step sideways to. That is the correct answer: falling back
 * onto something nobody can select, and which may have no key behind it,
 * is worse than reporting that there is no alternative.
 */
check('a model no longer shipped has no sibling', C.siblingModel('codestral-latest', new Set()), null)

/**
 * The catalogue is Gemini, and nothing else.
 *
 * Mistral, Groq and NVIDIA were measured and removed. Not because they
 * were worse - mistral-code-latest scored 37 of 38 ceiling rungs against
 * Gemini's 25, with no daily cap and 78 times the per-minute token
 * allowance - but because one provider is simpler to live with than four,
 * and this is the one chosen.
 *
 * The block this replaced checked which Mistral models a free key can
 * actually reach. That knowledge is not lost: it is in the git history and
 * in PROVIDERS, which still carries every provider so a key for one keeps
 * working. What is gone is the choice, and these checks make sure it stays
 * gone rather than creeping back one convenient entry at a time.
 */
/*
 * REOPENED, 15 October 2026, by the person whose app it is: "implement them
 * all (all the models) and allow me to switch via /model".
 *
 * The paragraph above is kept because its reasoning was sound at the time
 * and is the argument for narrowing again. What changed is the evidence.
 * Ten rungs of bench-ceiling at two runs each, measured that evening at
 * Wumpy's real 14,212-token preamble:
 *
 *   nemotron-3-super-120b   9/10   907ms     no daily cap
 *   deepseek-v4.1-flash     9/10   1,256ms   no daily cap
 *   nemotron-3-ultra-550b   9/10   2,495ms   no daily cap
 *   gemma4:31b-cloud        8/10     967ms   the user's own Ollama account
 *   gemini-3.1-flash-lite   8/10   2,278ms   the previous default
 *   gemini-3.8-flash        5/10  11,023ms   ~25 requests a day
 *
 * So the top of the picker is no longer Google, the fastest thing in it is
 * not Google, and Google's quota is the only one counted per day. "One
 * provider is simpler" was the right trade when the others were merely
 * equal; it is not when three of them are better on both axes at once.
 *
 * What these checks defend now is that every entry is REACHABLE and
 * HONEST, rather than that every entry is Gemini.
 */
for (const m of C.CLOUD_MODELS) {
  check(`${m.id} names a real provider`, C.PROVIDER_IDS.includes(m.provider), true)
  check(`${m.id} says what it costs`, m.blurb.length > 20, true)
  /* The catalogue is the authority on routing, so a model in it must route
     to the provider it claims - a typo here is a request to the wrong host. */
  check(`${m.id} routes to its own provider`, C.providerFor(m.id), m.provider)
}
check('and offers something', C.CLOUD_MODELS.length > 0, true)
check('the picker is no longer one provider', new Set(C.CLOUD_MODELS.map((m) => m.provider)).size > 1, true)

/**
 * Several variants rather than literally one, because the flash models
 * return 503 "high demand" often enough that having somewhere to go
 * matters more than a tidy single entry.
 */
check('with a fallback or two', C.CLOUD_MODELS.length >= 3, true)

/**
 * Every one of them must be flagged looseFences. Gemini writes
 * ```powershell where Wumpy asks for ```wumpy-run, and without the flag
 * its commands render as grey text with no button - which is how it scored
 * 1 of 38 before anyone noticed.
 */
/*
 * Gemini only, because the flag is a measurement and not a default. The
 * NVIDIA models scored 9/10 on a ladder that promotes fences for Google
 * alone, so they are writing wumpy-run themselves; flagging them would put
 * a Run button under an illustrative snippet for no reason.
 */
for (const m of C.CLOUD_MODELS.filter((m) => m.provider === 'google')) {
  check(`${m.id} is flagged looseFences`, Boolean(m.looseFences), true)
}

// The provider plumbing stays, so a key for another one is not orphaned.
check('the other providers are still routable', C.PROVIDER_IDS.length > 1, true)

/* ------------------------------------------------- the one that reasons anyway */

// NVIDIA hosts other people's open weights on a free developer key, and one of
// them - GLM-5.3 at 44.8 on the Artificial Analysis index - is the highest
// score available free anywhere. gpt-oss-120b, which this app has been using,
// is 24 on the same index.
//
// Unmeasured, like Mistral: there is no key for it and the write-a-file tasks
// have never run against it. What is checked here is that the shape is right,
// and in particular the one place its shape differs from everybody else's.
check('NVIDIA is a provider', Boolean(C.PROVIDERS.nvidia), true)
check(
  'with an OpenAI-compatible base',
  C.PROVIDERS.nvidia.base,
  'https://integrate.api.nvidia.com/v1'
)
check('paced for 40 requests a minute', C.PROVIDERS.nvidia.minGapMs * 40 >= 60_000, true)
check('and not paced on tokens', C.PROVIDERS.nvidia.tokensPerMinute, 0)
check('it does not need the system fold', C.PROVIDERS.nvidia.foldSystem, false)

// The top-level field is reported ignored there rather than refused, so
// sending it would be a no-op that reads like a setting.
check(
  'reasoning_effort is not sent to it',
  C.reasoningEffortFor('nvidia', false, 'z-ai/glm-5.3'),
  null
)
// The switch that does reach the model is inside chat_template_kwargs, where
// it goes to the chat template rather than the server.
check('the kwargs switch is sent instead', C.thinkingKwargsFor('nvidia', false), {
  enable_thinking: false,
  force_nonempty_content: true
})
check('and omitted when a tier wants reasoning', C.thinkingKwargsFor('nvidia', true), null)
// An empty object is still an unknown parameter to a provider that takes none.
for (const p of ['google', 'groq', 'mistral']) {
  check(`nothing is sent to ${p}`, C.thinkingKwargsFor(p, false), null)
}

// GLM-5.3 keeps reasoning whatever it is told, so a cap sized for the answer
// alone returns a sentence cut off mid-word - the exact failure measured on
// Google before reasoning_effort was found.
check('NVIDIA is marked as reasoning regardless', C.PROVIDERS.nvidia.alwaysReasons, true)
for (const p of ['google', 'groq', 'mistral']) {
  check(`${p} can be told to stop`, C.PROVIDERS[p].alwaysReasons, false)
}
check(
  'so the flash cap gets room anyway',
  C.maxTokensFor(384, false, 'nvidia'),
  384 + C.THINKING_ALLOWANCE
)
check('while Google keeps the tier’s own', C.maxTokensFor(384, false, 'google'), 384)
check('and no provider at all is unchanged', C.maxTokensFor(384, false), 384)

check('its models route there', C.providerFor('z-ai/glm-5.3'), 'nvidia')
/*
 * Ultra lost its row on 17 Oct and has it back.
 *
 * Three attempts at a measurement failed three ways: 41 rungs of 504 on 16
 * Oct, then a stream that opened and said nothing, then 503 "Service
 * temporarily overloaded" a minute later. An empty answer costs the turn
 * as completely as a 404, so it came out of the offered list - with a note
 * saying the routing was untouched and putting it back was one commit.
 *
 * Asked again on 21 Oct with the full preamble: "ready" in 1,006ms, the
 * quickest thing measured here. All three failures were the gateway having
 * a bad week, which is also what the 5xx retry added on 18 Oct absorbs.
 * This is the one commit.
 */
check('including Nemotron', C.providerFor('nvidia/nemotron-3-ultra-550b-a55b'), 'nvidia')
check(
  'and Ultra is offered again, because it answers now',
  C.CLOUD_MODELS.some((m) => m.id.includes('nemotron-3-ultra')),
  true
)
/* With a speed and no score: it has not been up the ladder since coming
   back, and `measured` absent is what keeps it out of the ranking and the
   recommendation until it has. */
/*
 * Laddered the same day it came back: 38 of 42 over two runs a rung, at
 * 1,006ms. The highest count anything here has posted and the quickest
 * time anything here has posted - from the model that had been dropped
 * four days earlier for answering with nothing.
 */
check(
  'and it has a real score now',
  C.CLOUD_MODELS.find((m) => m.id.includes('nemotron-3-ultra'))?.measured?.clean,
  38
)
check('taken at two runs a rung', C.CLOUD_MODELS.find((m) => m.id.includes('nemotron-3-ultra'))?.measured?.runs, 2)
/*
 * Everything offered has been up the ladder as of 21 Oct.
 *
 * Named rather than counted: an empty list is the ladder having finished
 * and a growing one is somebody adding a model without measuring it, and
 * a count of 0 could not tell those apart. `measured` absent keeps an
 * entry out of the ranking and the recommendation rather than letting it
 * be compared on nothing, which is why the field stays optional even
 * with nothing using it.
 */
check(
  'every offered model has been measured',
  C.CLOUD_MODELS.filter((m) => m.measured === undefined).map((m) => m.id),
  []
)
check('and DeepSeek', C.providerFor('deepseek-ai/deepseek-v4.1-flash'), 'nvidia')
// Routing still works for the retired id, which is the point: a model typed in
// by hand reaches the right endpoint and gets that endpoint's own 410, rather
// than failing here as an unknown name.
check('including the retired one', C.providerFor('deepseek-ai/deepseek-v4-pro'), 'nvidia')
check(
  'but it is not offered',
  C.CLOUD_MODELS.some((m) => m.id.endsWith('v4-pro')),
  false
)
/*
 * Every model offered for NVIDIA has been called once against a real key.
 *
 * Which is not a formality. `/v1/models` lists 81 ids and twenty-eight
 * plausible chat models were tried on 21 Oct: SEVENTEEN answered 404. The
 * listing is largely stale, so being in it is no evidence at all, and this
 * list is the record of what was actually dialled.
 */
/* nemotron-3-super is absent from the offered list as of 21 Oct - 404,
   "Function 'ac74040f-...': Not found", while Ultra answered 200 on the
   same key a second later. Its routing is kept; the row is gone. */
const NV_PROBED = [
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
  'moonshotai/kimi-k3',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'stepfun-ai/step-5-preview',
  'deepseek-ai/deepseek-v4.1-flash'
]
check(
  'nothing unprobed is offered',
  C.CLOUD_MODELS.filter((m) => m.provider === 'nvidia').every((m) => NV_PROBED.includes(m.id)),
  true
)
check('and MiniMax', C.providerFor('minimaxai/minimax-m2.7'), 'nvidia')
/**
 * Both Groq and NVIDIA serve Kimi, and nothing in the id says which, so the
 * catalogue used to decide and the shape rule was only a tie-break.
 *
 * With the catalogue reduced to Gemini there is no catalogue entry to
 * consult, so every Kimi now falls through to the shape rule and lands on
 * Groq. That is the documented fallback working, not a routing bug - and
 * it is worth asserting rather than deleting, because it is exactly what
 * would bite if a Kimi were ever added back expecting NVIDIA.
 */
check('an uncatalogued Kimi falls through to Groq', C.providerFor('moonshotai/kimi-k3'), 'groq')
check(
  'as does any other',
  C.providerFor('moonshotai/kimi-k2-instruct-0905'),
  'groq'
)
/**
 * The NVIDIA rotation orders its models by score, and now has somewhere to
 * go: with five of them catalogued, a model that is refused or busy can
 * step sideways instead of ending the turn. That stopped working when the
 * catalogue was narrowed to Gemini and works again now.
 *
 * A sibling is still only ever offered from models the app actually ships,
 * which is the invariant worth holding: codestral routes to Mistral and is
 * not in the catalogue, so there is nothing to step to.
 */
check('a catalogued NVIDIA model can step sideways', typeof C.siblingModel('z-ai/glm-5.3', new Set()), 'string')
check('and it stays on its own provider', C.providerFor(C.siblingModel('z-ai/glm-5.3', new Set())), 'nvidia')
check('a model the app does not ship has no sibling', C.siblingModel('codestral-latest', new Set()), null)
/* One Ollama model, so nowhere to go - and that is the right answer rather
   than a hop onto a hosted provider the user did not choose. */
check('nor does the only model on its provider', C.siblingModel('gemma4:31b-cloud', new Set()), null)
check('nor does a Kimi', C.siblingModel('moonshotai/kimi-k3', new Set()), null)
// And a model that IS shipped still finds one.
check(
  'a Gemini still rotates to another Gemini',
  C.providerFor(C.siblingModel('gemini-3.5-flash', new Set()) ?? 'gemini-3.5-flash'),
  'google'
)

// An NVIDIA key is nvapi-prefixed, so a Groq key pasted at the wrong provider
// is caught before it is encrypted and stored.
check(
  'an NVIDIA key is recognised',
  C.looksLikeKey('nvidia', 'nvapi-1234567890abcdefghijklmnop').ok,
  true
)
check(
  'a Groq key pasted there is not',
  C.looksLikeKey('nvidia', 'gsk_1234567890abcdefghijklmnop').ok,
  false
)

/* ------------------------------------------- one list of providers, not six */

// This was written out by hand in six places, and a provider missing from any
// one of them would not fail to compile: the key command would accept it, the
// store would encrypt it, and the next read would drop it as unrecognised.
check('there are five providers', C.PROVIDER_IDS.length, 5)
check(
  'and every one has a table entry',
  C.PROVIDER_IDS.every((id) => Boolean(C.PROVIDERS[id])),
  true
)
check(
  'and every entry is in the list',
  Object.keys(C.PROVIDERS).every((id) => C.PROVIDER_IDS.includes(id)),
  true
)
check('a known name is a provider', C.isProviderId('nvidia'), true)
check('an unknown one is not', C.isProviderId('openai'), false)
check('nor is undefined', C.isProviderId(undefined), false)
check('nor a near miss', C.isProviderId('Google'), false)

const types = read('src/shared/types.ts')
const mirrored = (types.match(/export type ProviderName =([^\n]*)/) ?? [])[1] ?? ''
check(
  'the renderer’s copy names the same four',
  C.PROVIDER_IDS.every((id) => mirrored.includes(`'${id}'`)),
  true
)
for (const f of ['src/main/keys.ts', 'src/main/index.ts', 'src/renderer/src/commands.ts']) {
  check(`${f} no longer lists them by hand`, /'google',\s*'groq'/.test(read(f)), false)
}
check('the key store walks the list', read('src/main/keys.ts').includes('PROVIDER_IDS'), true)
check(
  'and the IPC guard uses the predicate',
  read('src/main/index.ts').includes('isProviderId('),
  true
)

check('three turns fill a Groq minute', Math.floor(C.PROVIDERS.groq.tokensPerMinute / 2757), 2)
check('pacing keeps Google under 10 a minute', C.PROVIDERS.google.minGapMs * 10 >= 60_000, true)
check('and Groq under 30', C.PROVIDERS.groq.minGapMs * 30 >= 60_000, true)
check(
  'every catalogue model routes to its provider',
  C.CLOUD_MODELS.every((m) => C.providerFor(m.id) === m.provider),
  true
)
/*
 * Google left the picker, so the 3.8-flash blurb is no longer in it. What
 * replaces that assertion is the reason it existed: a model whose budget is
 * worth knowing before you pick it must say so in the list. Every entry now
 * names either its score or its cost.
 */
check(
  'every blurb says what it scored or what it costs',
  C.CLOUD_MODELS.every((m) => /\d/.test(m.blurb)),
  true
)
check('and no Gemini is offered', C.CLOUD_MODELS.some((m) => m.provider === 'google'), false)
/* The routing rule stays, so a name typed by hand still reaches Google -
   which is what makes this reversible rather than a deletion. */
check('but one typed by hand still routes', C.providerFor('gemini-3.1-flash-lite'), 'google')

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

/* ------------------------------------------- when there is nothing local */

// Ollama is not always there: stopped, mid-update, or never installed. With a
// key saved there is still a model available, it is just not on this machine.
check(
  'every tier has a hosted fallback',
  C.CLOUD_MODELS.length > 0 &&
    ['flash', 'fast', 'thinker', 'deep'].every((t) => C.FALLBACK_CLOUD_MODEL[t]),
  true
)
check(
  'each one is a real catalogue model',
  ['flash', 'fast', 'thinker', 'deep'].every((t) =>
    C.CLOUD_MODELS.some((m) => m.id === C.FALLBACK_CLOUD_MODEL[t])
  ),
  true
)
check(
  'and routes to a provider',
  ['flash', 'fast', 'thinker', 'deep'].every(
    (t) => C.providerFor(C.FALLBACK_CLOUD_MODEL[t]) !== null
  ),
  true
)
// A daily cap is not something to land on by default, and now nothing in
// the fallback map has one at all.
check(
  'never a model counted per day',
  Object.values(C.FALLBACK_CLOUD_MODEL).some((m) => C.providerFor(m) === 'google'),
  false
)
check(
  'the acting tiers get one that scored 9/10',
  C.FALLBACK_CLOUD_MODEL.thinker,
  'deepseek-ai/deepseek-v4.1-flash'
)
/* Every fallback has to be something the picker actually offers, or a tier
   falls through to a name the user cannot see or select. */
check(
  'and every fallback is in the catalogue',
  Object.values(C.FALLBACK_CLOUD_MODEL).every((m) => C.CLOUD_MODELS.some((c) => c.id === m)),
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
/**
 * Background work is no longer guaranteed to stay on this machine.
 *
 * It used to be pinned to a local model however the tiers were set, and the
 * reason that mattered was not speed: compaction sends the whole conversation,
 * which by then may hold command output and the contents of files, and the
 * free tiers train on what they are sent. Removing Ollama removed the only
 * answer to that, and the honest thing is to assert what is true now rather
 * than quietly drop the check.
 */
check('titling goes through the one client', /cloud\.complete\(/.test(main), true)
check('and the comment says what that cost', /no longer[\s\S]{0,40}has an answer/i.test(main), true)
check('there is one client, so nothing picks between them', /clientFor\(/.test(main), false)
check('warming is gone with the local path', /function warmTier/.test(main), false)
check('and the measurement that justified it is kept', /30\.6-36\.2s of prefill/.test(main), true)
check('aborting reaches the client', /cloud\.abort\(requestId\)/.test(main), true)

/* ------------------------------ the limit Google actually names */

// retryDelay was the wrong thing to read, and it misled twice: a model asking
// for eighteen hours answered normally forty minutes later. The error carries
// a quotaId naming the limit that was hit, which is not a guess.
const perDay = C.classifyLimit(
  429,
  '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","retryDelay":"52000s"}',
  'gemini-3.5-flash'
)
check('a per-day quota means the day is over', perDay.kind, 'exhausted')
check('so nothing is slept', perDay.waitMs, 0)
check('and it says requests, not tokens', perDay.message.includes('free requests for today'), true)

// The same enormous retryDelay, and this one clears in a minute - exactly the
// case the old duration threshold got wrong.
const perMin = C.classifyLimit(
  429,
  '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","retryDelay":"52000s"}',
  'm'
)
check('a per-minute quota is only a throttle', perMin.kind, 'throttle')
check('despite asking for fourteen hours', perMin.waitMs <= C.GIVE_UP_AFTER_MS, true)
check('and it does not claim the day is gone', perMin.message.includes('today'), false)

/* ----------------------------------------- sideways before down */

// The cap is per model - the quota id says PerModel, and it was measured:
// gemini-3.5-flash refused with 14.5h to go while flash-lite and 3.8-flash
// answered on the same key in the same minute.
/* Now read against NVIDIA, which is where the shipped models live. The rule
   is unchanged and so is the reason for it: a model refused or busy should
   step sideways rather than end the turn. */
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'
check('a spent model has a sibling to try', typeof C.siblingModel(SUPER, new Set()), 'string')
check('never itself', C.siblingModel(SUPER, new Set()) !== SUPER, true)
check(
  'nor one already known to be spent',
  C.siblingModel(SUPER, new Set([C.siblingModel(SUPER, new Set())])) !==
    C.siblingModel(SUPER, new Set()),
  true
)
check('nor does a Groq model', C.siblingModel('openai/gpt-oss-120b', new Set()), null)
// A shipped model still finds one, and stays with its provider.
check(
  'a shipped model stays with its provider',
  C.providerFor(C.siblingModel(SUPER, new Set())),
  'nvidia'
)
check(
  'and gives up when every one is spent',
  C.siblingModel(
    'gemini-3.5-flash',
    new Set([
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-flash-latest',
      'gemini-3.1-flash-lite'
    ])
  ),
  null
)

/**
 * Probed one request each against the live API.
 *
 * The /models listing happily includes models that answer 400 or 404 when
 * asked to generate. Three of them were in the rotation, so a model running
 * out stepped sideways onto one and failed - visible in /usage as rows with
 * one turn, no tokens and one failure.
 */
for (const dead of ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-lite-latest']) {
  check(
    `${dead} is not offered`,
    C.CLOUD_MODELS.some((m) => m.id === dead),
    false
  )
}
// A dud that appears later should move the turn along rather than hand the
// user a status code.
check(
  'an unusable model is answerable elsewhere',
  readFileSync('src/main/cloud.ts', 'utf8').includes("kind: unusableModel ? 'unusable' : 'other'"),
  true
)
check(
  'and is never rotated to again',
  readFileSync('src/main/index.ts', 'utf8').includes(
    "if (failure?.kind === 'unusable') spentToday.add(on)"
  ),
  true
)
check('a local model has no sibling', C.siblingModel('phi4-mini:3.8b', new Set()), null)

/* ------------------------- a locked model is not a throttle -------------- */

/**
 * Mistral answers 429 "Rate limit exceeded" for a model that is not on your
 * plan at all - the same status and almost the same words as being told to
 * slow down. The only thing that tells them apart is the header: the
 * per-minute allowance is 0 rather than 125.
 *
 * It matters because /model offers these. On a free key
 * mistral-medium-latest, mistral-small-latest and the magistral models all
 * report 0, so choosing one looked like a passing hiccup and waiting never
 * helped.
 */
{
  const locked = C.classifyLimit(429, '{"message":"Rate limit exceeded"}', 'mistral-medium-latest', '0')
  check('a zero allowance is permanent', locked.kind, 'exhausted')
  check('and says which model and what to do', /not available on this API plan/.test(locked.message), true)
  check('and does not ask anyone to wait', locked.waitMs, 0)

  // A real throttle still behaves as a throttle.
  const busy = C.classifyLimit(429, '{"message":"Rate limit exceeded"}', 'codestral-latest', '125')
  check('a real allowance is still a throttle', busy.kind !== 'exhausted', true)
  // And a provider that sends no such header is unaffected either way.
  const silent = C.classifyLimit(429, '{"message":"Rate limit exceeded"}', 'codestral-latest', null)
  check('a missing header changes nothing', silent.kind, busy.kind)
}

/**
 * A GATEWAY 5xx IS INFRASTRUCTURE, AND THE APP NOW TREATS IT LIKE ONE.
 *
 * Seen on 18 Oct on an ordinary question, with every key healthy and
 * nothing rate limited:
 *
 *   NVIDIA NIM returned 500: {"message":"Failed to generate completions",
 *   "type":"Internal Server Error","code":500}
 *
 * 503 was the only transient status, so this one fell through to "other",
 * was never retried, and reached the user as a status code wrapped round
 * an error object. This file already knew better in the catalogue, where
 * the VL model has two ladder runs because "the first run hit a 500 and a
 * 502 from the gateway - infrastructure, not the model". The bench excused
 * them; the app did not.
 */
{
  const body = '{"message":"Failed to generate completions","type":"Internal Server Error","code":500}'
  for (const status of [500, 502, 503, 504]) {
    const v = C.classifyLimit(status, body, 'z-ai/glm-5.3-flash')
    check(`a ${status} is the provider having a bad minute`, v.kind, 'busy')
    /* Worth waiting for, and not for ever: the retry loop gives it two
       goes, so the wait has to be short enough that two of them are not
       the turn. */
    check(`and ${status} is worth waiting out`, v.waitMs > 0 && v.waitMs <= C.GIVE_UP_AFTER_MS, true)
  }

  /* 4xx is OURS. A malformed request is malformed again on the retry, and
     400/404 still mean "that model is not there - try another". */
  check('a 400 is not retried', C.classifyLimit(400, body, 'm').kind, 'other')
  check('nor a 404', C.classifyLimit(404, body, 'm').kind, 'other')
  check('nor a 401', C.classifyLimit(401, body, 'm').kind, 'other')

  /* The retry gate has to actually include busy, or the classification is
     a label with nothing behind it. */
  const main = read('src/main/cloud.ts')
  check(
    'and busy is one of the two that retries',
    /verdict\.kind === 'throttle' \|\| verdict\.kind === 'busy'/.test(main),
    true
  )

  /*
   * What the user reads when it does not clear. The provider's sentence,
   * not its error object: the body above restates the status three times
   * and carries one fact.
   */
  check(
    'a persistent failure quotes the message, not the JSON',
    main.includes('const said = /"message":') && main.includes('.exec(stripKey(detail'),
    true
  )
  check('and says whose fault it is', /their gateway rather than your key/.test(main), true)
  check('and that it already tried again', /retried twice already/.test(main), true)
  /* elsewhere: a 5xx is this provider's bad minute, so another model is
     worth trying; that was already right and must stay. */
  check('a 5xx still suggests elsewhere', /elsewhere: unusableModel \|\| res\.status >= 500/.test(main), true)
}

/* ------------------------------------------- waiting, and knowing you waited */

/**
 * The gap between requests is divided the way the LIMIT is divided, and it
 * has to stay that way in both directions.
 *
 * Per key, for Google. Its entry says "10 requests a minute on the free
 * tier, so 6s plus a margin" — ten per PROJECT, and every key in the pool
 * is its own project. Keyed on the provider it was one queue for all
 * twenty: a follow-up asked within seven seconds of the last answer sat
 * there doing nothing before it was sent, and a turn is rarely one request.
 * A command's output is another, a compaction is another, the title is
 * another, so a three-step sequence paid twenty-one seconds of nothing
 * while nineteen keys were idle.
 *
 * Per ACCOUNT, for everyone else, and this half was added the day a second
 * NVIDIA key arrived. That ceiling is the account's: two keys each keeping
 * their own 1,700ms gap put about seventy requests a minute through a limit
 * of forty, so the second key would have made refusals likelier than one
 * key was - the opposite of the reason for adding it.
 *
 * UNLESS THE KEYS ARE ON SEPARATE ACCOUNTS, which no amount of looking at a
 * key will reveal and the user simply knows. `/key <provider> accounts
 * separate` is them saying so, and then two keys really are two ceilings
 * and pace independently again. The decision lives in CloudClient.separate
 * because it needs both halves: the provider's metering, and the setting.
 *
 * All three are the same rule. None is safe to apply to the others.
 */
{
  const main = read('src/main/cloud.ts')
  check(
    'the gap is divided the way the allowance is',
    /const slot = separate \? `\$\{provider\}:\$\{key\}` : provider/.test(main),
    true
  )
  check('Google is still the per-key case', C.PROVIDERS.google.quotaPerKey, true)
  check('and NVIDIA shares one queue by default', C.keysAreSeparate('nvidia'), false)
  check('until the user says otherwise', C.keysAreSeparate('nvidia', 'separate'), true)
  /* And saying "shared" cannot take Google's away, because that one is a
     fact about the metering rather than about the setup. */
  check('which cannot be said away for Google', C.keysAreSeparate('google', 'shared'), true)
  check(
    'and the sender paces the key it picked',
    /await pace\(provider, index, 0, this\.separate\(provider\)\)/.test(main),
    true
  )
  check(
    'including the background work',
    main.indexOf('const index = background.next') <
      main.lastIndexOf('await pace(provider, index, 0, this.separate(provider))'),
    true
  )
  check('and a wait long enough to notice is logged', /holding key \$\{key \+ 1\}/.test(main), true)

  /* "A bit slow" had nowhere to be answered from: the log timed the hotkey
     to the millisecond and said nothing about how long an answer took. */
  check('every turn reports what it cost', /turn done: \$\{stats\.loadMs/.test(main), true)
  check('with the reason it stopped', /finish=\$\{finish \|\| 'none'\}/.test(main), true)

  /**
   * And an answer that stopped is not an answer that finished. Unread, a
   * reply that hit the output cap ended the turn exactly like a complete
   * one - dots gone, runtime printed, half a sentence on screen.
   */
  check('the finish reason is read at all', /finish_reason/.test(main), true)
  check(
    'only the two that say it stopped short',
    /finish === 'length' \|\| finish === 'content_filter'/.test(main),
    true
  )
  const chat = read('src/renderer/src/hooks/useChat.ts')
  check('the message is marked before the turn clears', /if \(d\.cutOff\)/.test(chat), true)
  check(
    'and the transcript says so',
    /hit the length limit/.test(read('src/renderer/src/components/Message.tsx')),
    true
  )
}

/**
 * Highlighting waits for the end of the answer.
 *
 * The whole message is re-parsed on every commit of the reveal, about
 * thirty a second, and rehype-highlight re-tokenises every code block each
 * time: 0.45ms a commit at 4,000 characters, 0.76ms at 8,000, so 14-23ms of
 * every second spent colouring text that is still being written.
 */
check(
  'code is coloured once the answer lands, not while it arrives',
  /rehypePlugins=\{complete \? HIGHLIGHT : NO_HIGHLIGHT\}/.test(
    read('src/renderer/src/components/Markdown.tsx')
  ),
  true
)

console.log(failures ? `\n${failures} cloud checks FAILED` : '\nall cloud checks')
process.exitCode = failures ? 1 : 0

/* ------------------------------------------------- the rank beside the name */

/**
 * The list is chosen from by how good each model is, so that belongs in the
 * row rather than mid-sentence in a blurb - asked for as "a tag of how smart
 * they are in the rankings".
 *
 * What these defend is that the badge cannot lie. A score is a number with
 * `of` and `runs` beside it, because the same model scored 10/10 on ten rungs
 * at one run and 9/10 on the same ten at two; and the order on screen is
 * computed from those numbers rather than typed, so it cannot drift from them.
 */
const ranked = C.rankedModels()
check('every catalogue model is ranked or explicitly not', ranked.length, C.CLOUD_MODELS.length)

const measured = ranked.filter((r) => r.model.measured)
check('the measured ones all have a place', measured.every((r) => r.rank !== null), true)
check('and the places are 1..n with no gaps', new Set(measured.map((r) => r.rank)).size, measured.length)
check('someone is first', measured.some((r) => r.rank === 1), true)

/*
 * Usable first, then score, then speed - asserted on the real catalogue
 * so a future edit that sorts by speed alone is caught.
 *
 * The first clause is new on 19 Oct and is the one with a story. It was
 * score-then-speed, which put deepseek at the top of the picker on 39/41
 * while taking 112 seconds a turn - a #1 badge beside a model the
 * recommendation refuses to suggest, on the same screen. A rank shown to
 * someone choosing is advice, so "best" has to mean best to use.
 */
const byRank = measured.slice().sort((a, b) => a.rank - b.rank)
const answers = (m) => m.medianMs < C.UNUSABLY_SLOW_MS
for (let i = 1; i < byRank.length; i++) {
  const prev = byRank[i - 1].model.measured
  const here = byRank[i].model.measured
  const better = prev.clean / prev.of > here.clean / here.of
  const same = prev.clean / prev.of === here.clean / here.of
  check(
    `#${i} is not beaten by #${i + 1}`,
    (answers(prev) && !answers(here)) ||
      (answers(prev) === answers(here) && (better || (same && prev.medianMs <= here.medianMs))),
    true
  )
}
/* And the specific case, named, so it cannot regress quietly. */
check(
  'the highest scorer is not first when it takes two minutes',
  byRank[0].model.id !== 'deepseek-ai/deepseek-v4.1-flash',
  true
)
check(
  'though it keeps the highest score',
  Math.max(...measured.map((r) => r.model.measured.clean / r.model.measured.of)),
  39 / 41
)

/* A measurement with no `of` is not a measurement; a share over 1 is a typo
   that would sort to the top and be believed. */
for (const m of C.CLOUD_MODELS.filter((m) => m.measured)) {
  const x = m.measured
  check(`${m.id} scored out of something`, x.of > 0 && x.clean <= x.of, true)
  check(`${m.id} says how many runs`, x.runs >= 1, true)
  check(`${m.id} says when`, /^\d{4}-\d{2}-\d{2}$/.test(x.on), true)
}

/* A catalogue with no measurements at all would pass every check above by
   having nothing to check, which is the shape of a feature that quietly
   stopped being maintained. */
check('the catalogue actually carries measurements', measured.length > 0, true)

const top = C.modelTag(byRank[0].model, 1)
check('the badge names the place and the score', /^#1 · \d+\/\d+$/.test(top.text), true)
check('and the best one is coloured as the best', top.tone, 'top')
check('the tooltip carries how hard it was measured', /run/.test(top.title) && /rungs/.test(top.title), true)
/* An unmeasured model gets no badge at all, rather than a confident blank. */
check('an unmeasured model gets no badge', C.modelTag({ id: 'x', provider: 'nvidia', label: 'x', blurb: 'x' }, null), null)

const renderer = readFileSync('src/renderer/src/App.tsx', 'utf8')

/* ------------------------------------------- turning the thinking off */

/*
 * `/think` and `/nothink` only mean anything if the switch reaches the
 * model, and every provider takes a different one. Measured 21 Oct on
 * qwen3.6:35b-a3b, a 35B reasoning model on this machine, asked for one
 * word: 19,907ms with nothing sent, 18,844 with NVIDIA's
 * chat_template_kwargs, 25,520 with reasoning_effort low - and 772ms
 * with reasoning_effort none. Twenty-five times, and only one of the
 * three switches does anything.
 */
check('ollama takes none, not low', C.reasoningEffortFor('ollama', false), 'none')
check('and nothing at all when thinking is wanted', C.reasoningEffortFor('ollama', true), null)
/* NVIDIA ignores the field and refuses nothing, so sending it there
   would be a comforting no-op; its switch is the template one. */
check('nvidia still gets no effort field', C.reasoningEffortFor('nvidia', false), null)
check('but does get the template switch', C.thinkingKwargsFor('nvidia', false) !== null, true)
/* And Ollama gets no template switch, because it ignores that one. */
check('ollama gets no template switch', C.thinkingKwargsFor('ollama', false), null)

/* --------------------------------------- a local model is addressable */

/*
 * The routing was `-cloud` only, on the reasoning that a plain
 * `phi4-mini:3.8b` is a local model and Wumpy has no local client. Both
 * halves were wrong: Ollama's OpenAI endpoint serves local and cloud
 * models at the same URL - the one `gemma4:31b-cloud` has been using all
 * along - and the suffix test was too narrow even for cloud models.
 *
 * Measured on this machine: the daemon offers `qwen3.6:35b-a3b`, a 35B
 * local model whose own capability list includes vision, and
 * `minimax-m3.1-flash:cloud`. The old `/:.*-cloud$/` matched NEITHER.
 */
check('a local model routes to the daemon', C.providerFor('qwen3.6:35b-a3b'), 'ollama')
check('and the newer cloud naming does too', C.providerFor('minimax-m3.1-flash:cloud'), 'ollama')
check('as does the older one', C.providerFor('gemma4:31b-cloud'), 'ollama')
/* Safe because the shapes do not overlap: every NVIDIA id has a slash,
   and the bare Mistral names have no colon. */
check('a slashed id is still NVIDIA', C.providerFor('nvidia/nemotron-3-ultra-550b-a55b'), 'nvidia')
check('and a bare Mistral name is still Mistral', C.providerFor('mistral-large'), 'mistral')

check('the picker orders by the measured rank', /rankedModels\(\)/.test(renderer), true)
check('and shows the badge', /modelTag\(m, rank\)/.test(renderer), true)

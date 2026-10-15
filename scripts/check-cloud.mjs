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
check('including Nemotron', C.providerFor('nvidia/nemotron-3-ultra-550b-a55b'), 'nvidia')
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
// Every model offered for NVIDIA has been called once against a real key.
const NV_PROBED = [
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
  'moonshotai/kimi-k3',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-super-120b-a12b',
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
// 25 requests a day is not something to land on by default.
check(
  'never the 25-a-day model',
  Object.values(C.FALLBACK_CLOUD_MODEL).includes('gemini-3.8-flash'),
  false
)
check(
  'the acting tiers get the one that scored 8/8',
  C.FALLBACK_CLOUD_MODEL.thinker,
  'gemini-3.5-flash'
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
check(
  'a spent model has a sibling to try',
  C.siblingModel('gemini-3.5-flash', new Set()),
  'gemini-3.6-flash'
)
check(
  'never itself',
  C.siblingModel('gemini-3.1-flash-lite', new Set()) !== 'gemini-3.1-flash-lite',
  true
)
check(
  'nor one already known to be spent',
  C.siblingModel('gemini-3.5-flash', new Set(['gemini-3.6-flash'])),
  'gemini-3.7-flash'
)
check('nor does a Groq model', C.siblingModel('openai/gpt-oss-120b', new Set()), null)
// A shipped model still finds one, and stays with its provider.
check(
  'a shipped model stays with its provider',
  C.providerFor(C.siblingModel('gemini-3.5-flash', new Set())),
  'google'
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

/* ------------------------------------------- waiting, and knowing you waited */

/**
 * The gap between requests is per KEY, and it has to stay that way.
 *
 * Google's entry says "10 requests a minute on the free tier, so 6s plus a
 * margin" — ten per PROJECT, and every key in the pool is its own project.
 * Keyed on the provider it was one queue for all twenty: a follow-up asked
 * within seven seconds of the last answer sat there doing nothing before it
 * was sent, and a turn is rarely one request. A command's output is
 * another, a compaction is another, the title is another, so a three-step
 * sequence paid twenty-one seconds of nothing while nineteen keys were idle.
 */
{
  const main = read('src/main/cloud.ts')
  check('the gap is kept per key', /const slot = `\$\{provider\}:\$\{key\}`/.test(main), true)
  check('and the sender paces the key it picked', /await pace\(provider, index\)/.test(main), true)
  check(
    'including the background work',
    main.indexOf('const index = background.next') < main.lastIndexOf('await pace(provider, index)'),
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

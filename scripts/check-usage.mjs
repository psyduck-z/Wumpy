/**
 * Counting what was spent, and the two backends being genuinely two.
 *
 * The accounting matters more than it looks. The free quotas turned out to be
 * the binding constraint and they are invisible until they run out, so a total
 * that is quietly wrong is worse than no total - it would say there is room
 * when there is not. The thinking tokens are the specific trap: they appear in
 * neither of the fields a reasonable person would add up.
 *
 * Run with: node scripts/check-usage.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

async function load(entry, name) {
  const out = join(process.cwd(), `.usage-check-${name}.mjs`)
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
const U = await load('src/shared/usage.ts', 'u')
const T = await load('src/shared/tiers.ts', 't')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  const shown = JSON.stringify(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${shown?.length > 50 ? `${shown.slice(0, 50)}…` : shown}`
  )
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* -------------------------------------------------------------- the counting */

let day = { date: '2026-10-08', models: {} }
day = U.record(day, {
  model: 'gemini-3.5-flash',
  via: 'google',
  promptTokens: 1154,
  completionTokens: 335,
  thinkingTokens: 487,
  generatingMs: 2000
})
day = U.record(day, {
  model: 'gemini-3.5-flash',
  via: 'google',
  promptTokens: 1200,
  completionTokens: 300,
  thinkingTokens: 400,
  generatingMs: 2000
})
day = U.record(day, {
  model: 'phi4-mini:3.8b',
  via: 'local',
  promptTokens: 1080,
  completionTokens: 250,
  generatingMs: 18000
})

const lines = U.summarise(day)
check('one line per model', lines.length, 2)
check('the busiest first', lines[0].model, 'gemini-3.5-flash')
check('turns are counted', lines[0].requests, 2)

// 1154+335+487 + 1200+300+400 = 3876. Adding only prompt and completion would
// say 2989, understating by the 887 that was spent thinking.
check('thinking is in the total', lines[0].tokens, 3876)
check('and is shown separately', lines[0].thinking, 887)
check('local speed is computed', Math.round(lines[1].tokensPerSecond), 14)
check('hosted speed is computed', Math.round(lines[0].tokensPerSecond), 159)

let cached = U.record(
  { date: 'd', models: {} },
  {
    model: 'openai/gpt-oss-120b',
    via: 'groq',
    promptTokens: 7495,
    completionTokens: 100,
    cachedTokens: 4076
  }
)
check('cached tokens come off the bill', U.summarise(cached)[0].tokens, 7495 + 100 - 4076)

check('record does not mutate', Object.keys({ date: 'd', models: {} }.models).length, 0)
check(
  'an error is counted without tokens',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'x', via: 'google', error: true }))[0]
    .errors,
  1
)
check(
  'a rate limit is counted apart from a failure',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'x', via: 'google', error: true, limited: true })
  )[0].limited,
  1
)
check(
  'no generating time is not a divide by zero',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'x', via: 'local', completionTokens: 10 })
  )[0].tokensPerSecond,
  0
)

/* ------------------------------------------------------------ the allowances */

const burned = { date: 'd', models: {} }
let d38 = burned
for (let i = 0; i < 25; i++)
  d38 = U.record(d38, { model: 'gemini-3.8-flash', via: 'google', promptTokens: 100 })
check('the 25-a-day model reads as spent', U.summarise(d38)[0].usedFraction, 1)
check('and says where the number came from', U.summarise(d38)[0].note.includes('measured'), true)
check(
  'a model with no known cap says nothing false',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'gemini-3.5-flash', via: 'google' }))[0]
    .usedFraction,
  null
)
check(
  'a local model has no cap at all',
  U.summarise(U.record({ date: 'd', models: {} }, { model: 'phi4-mini:3.8b', via: 'local' }))[0]
    .usedFraction,
  null
)
check(
  'and says so',
  U.summarise(
    U.record({ date: 'd', models: {} }, { model: 'phi4-mini:3.8b', via: 'local' })
  )[0].note.includes('this PC'),
  true
)
check(
  'never over 100%',
  U.summarise(U.record(d38, { model: 'gemini-3.8-flash', via: 'google' }))[0].usedFraction <= 1,
  true
)

check('today is a local date, not UTC', U.todayKey(new Date(2026, 0, 5)), '2026-01-05')
check('and is zero padded', U.todayKey(new Date(2026, 10, 1)), '2026-11-01')

/* -------------------------------------------------------- the two backends */

for (const id of ['flash', 'fast', 'thinker', 'deep']) {
  const tier = T.TIERS[id]
  check(`${id} has a local model`, Boolean(tier.model), true)
  check(`${id} has a hosted one`, Boolean(tier.apiModel), true)
  check(`${id} never defaults to the 25-a-day model`, tier.apiModel === 'gemini-3.8-flash', false)
}

// A cap sized for 13 tok/s is a truncation at 170.
check(
  'the acting tier gets more room on the API',
  T.TIERS.thinker.apiOptions.num_predict > T.TIERS.thinker.options.num_predict,
  true
)
check(
  'so does the deep one',
  T.TIERS.deep.apiOptions.num_predict > T.TIERS.deep.options.num_predict,
  true
)
check(
  'every tier that overrides raises the cap',
  ['flash', 'fast', 'thinker', 'deep'].every((id) => {
    const t = T.TIERS[id]
    return !t.apiOptions?.num_predict || t.apiOptions.num_predict >= t.options.num_predict
  }),
  true
)

// The local prompts are corrections for a 3.8B model; carrying them over would
// be an instruction to give the shallow answer.
check(
  'the local base tells the model to stop talking',
  T.TIERS.fast.systemPrompt.includes('Answer directly and stop'),
  true
)
check(
  'the API one does not',
  T.TIERS.fast.apiSystemPrompt.includes('Answer directly and stop'),
  false
)
check(
  'nor does it cap Flash at two sentences verbatim',
  T.TIERS.flash.apiSystemPrompt.includes('One or two sentences.'),
  false
)
check(
  'the API prompt asks for length to fit the question',
  T.TIERS.fast.apiSystemPrompt.includes('fit the question'),
  true
)
check(
  'and for uncertainty to be said out loud',
  T.TIERS.fast.apiSystemPrompt.includes('unsure'),
  true
)
check(
  'every tier has an API voice',
  ['flash', 'fast', 'thinker', 'deep'].every((id) => Boolean(T.TIERS[id].apiSystemPrompt)),
  true
)

// Worked examples exist because a small model imitates. A capable one imitates
// their register too, and they cost 110 tokens of a request-capped quota.
check('the local path has worked examples', T.shellExamples('full').length > 0, true)
check('the API path has none', T.API_EXAMPLES.length, 0)

/* ------------------------------------------------- the split is real in code */

const main = readFileSync('src/main/index.ts', 'utf8')
check('resolution branches on the backend', /activeBackend\(\) === 'api'/.test(main), true)
check('the prompt does too', /apiSystemPrompt \?\? tier\.systemPrompt/.test(main), true)
check('and the options', /apiOptions[\s\S]{0,60}tier\.options/.test(main), true)
check(
  'API with no key falls back rather than dying',
  /wanted === 'api' && !keys\?\.configured\(\)\.length/.test(main),
  true
)
check(
  'usage is recorded on success',
  /usage\.add\(\{[\s\S]{0,200}promptTokens: stats\.promptTokens/.test(main),
  true
)
check('and on failure', /usage\.add\(\{[\s\S]{0,160}error: true/.test(main), true)
check(
  'local is the default',
  readFileSync('src/shared/defaults.ts', 'utf8').includes("backend: 'local'"),
  true
)
check(
  'no prompt text is stored with the counts',
  /content|text|prompt:/.test(
    readFileSync('src/shared/usage.ts', 'utf8')
      .split('export interface ModelUsage')[1]
      .split('}')[0]
  ),
  false
)

console.log(failures ? `\n${failures} usage checks FAILED` : '\nall usage checks')
process.exitCode = failures ? 1 : 0

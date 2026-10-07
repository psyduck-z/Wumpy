/**
 * Checks the things that decide whether the KV cache survives between turns.
 *
 * None of these are visible when they break. The model still answers, the
 * answer is still right, and the only symptom is that it took forty seconds
 * instead of six — which reads as "local models are slow" rather than as a bug.
 * Three separate instances of it have shipped in this app, so the invariants
 * are asserted rather than remembered:
 *
 *   - a prime that omitted num_ctx sized a context nobody used    46-65s prefill
 *   - a prime that stopped one block short of the real shape       7.3-8.6s
 *   - a background call with no num_ctx, tearing down the runner   reload + full
 *
 * Measured against 0.85-0.97s when every one of them lines up.
 *
 * Run with: npm run check:cache
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.cache-check.mjs')
await build({
  entryPoints: ['src/shared/tiers.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const t = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
}

/* ------------------------------------------- one context size for everything */

const sizes = new Map()
for (const [id, tier] of Object.entries(t.TIERS)) {
  sizes.set(tier.options.num_ctx, [...(sizes.get(tier.options.num_ctx) ?? []), id])
}
check(
  sizes.size === 1,
  sizes.size === 1
    ? `every tier asks for num_ctx ${[...sizes.keys()][0]}`
    : `tiers disagree on num_ctx: ${[...sizes].map(([n, ids]) => `${n} (${ids.join(', ')})`).join(' vs ')}`
)
check(
  [...sizes.keys()][0] === t.NUM_CTX,
  `tiers use the exported NUM_CTX (${t.NUM_CTX})`
)

/**
 * Two tiers on one model must agree on everything that sizes a runner, or
 * switching between them reloads the model.
 */
const byModel = new Map()
for (const [id, tier] of Object.entries(t.TIERS)) {
  byModel.set(tier.model, [...(byModel.get(tier.model) ?? []), { id, tier }])
}
for (const [model, tiers] of byModel) {
  if (tiers.length < 2) continue
  const ctxs = new Set(tiers.map((x) => x.tier.options.num_ctx))
  check(ctxs.size === 1, `${tiers.map((x) => x.id).join(' and ')} share ${model} and its context size`)
}

/* ------------------------------ nothing may call the model without a num_ctx */

const ollama = readFileSync('src/main/ollama.ts', 'utf8')
check(
  /numCtx: number/.test(ollama),
  'complete() requires a num_ctx rather than accepting the default'
)
check(
  /num_ctx: opts\.numCtx/.test(ollama),
  'complete() passes that num_ctx to Ollama'
)
check(
  /facts\?: string/.test(ollama),
  'warm() takes the live facts block, so it primes the shape a real turn sends'
)

const index = readFileSync('src/main/index.ts', 'utf8')
check(
  (index.match(/ollama\.complete\(/g) ?? []).length ===
    (index.match(/numCtx: NUM_CTX/g) ?? []).length,
  'every complete() call passes NUM_CTX'
)

/* --------------------------------- the preamble is built once, not per caller */

check(
  (index.match(/function systemPromptFor/g) ?? []).length === 1 &&
    (index.match(/SHELL_PROMPT : scope === 'read'/g) ?? []).length === 1,
  'the system prompt is assembled in exactly one place'
)
check(
  (index.match(/function factsFor/g) ?? []).length === 1 &&
    (index.match(/Facts about right now/g) ?? []).length === 1,
  'the facts block is assembled in exactly one place'
)

/* ----------------------------------- the volatile parts stay out of the prefix */

/**
 * The preamble has to be byte-identical between turns, so nothing in it may
 * depend on the clock beyond the date, or on anything that changes mid-chat.
 */
const facts = index.slice(index.indexOf('function factsFor'), index.indexOf('let lastChatTitle'))
check(!/getHours|getMinutes|toLocaleTimeString|Date\.now/.test(facts), 'no clock time in the facts block')
check(!/messageCount/.test(facts), 'no message count in the facts block')

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} cache-shape checks`)
process.exit(failed === 0 ? 0 : 1)

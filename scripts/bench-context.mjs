/**
 * Measures generation speed against how full the context is.
 *
 * Weights are not the only thing read per token. Every token also reads the
 * whole KV cache, and for phi4-mini that is about 128KB per token held
 * (32 layers x 8 KV heads x 128 dims x 2 for K and V x 2 bytes) - so a
 * conversation with 4000 tokens in it adds roughly 500MB to the 2.49GB of
 * weights, on every single token generated.
 *
 * On a machine pinned at its memory bandwidth, that is a fifth of the speed.
 * Which is why a long chat feels slower than a fresh one, and why flash
 * attention and a quantized KV cache are worth measuring here rather than on a
 * one-line prompt where they can do nothing.
 *
 * Run with: node scripts/bench-context.mjs [label]
 */
const MODEL = process.env.BENCH_MODEL ?? 'phi4-mini:3.8b'
const label = process.argv[2] ?? 'current'

/** Filler with no repetition a cache could collapse, so the context is real. */
function filler(words) {
  const out = []
  for (let i = 0; i < words; i++) {
    out.push(`item${i} value${(i * 7919) % 1000} tag${(i * 104729) % 97}`)
  }
  return out.join(' ')
}

async function run(contextWords) {
  const history = contextWords
    ? [
        { role: 'user', content: `Here is a log, just acknowledge it:\n${filler(contextWords)}` },
        { role: 'assistant', content: 'Noted.' }
      ]
    : []

  /**
   * Streamed, not because the numbers need it, but because undici gives up
   * waiting for response headers after five minutes - and a six-thousand-token
   * prefill on a CPU can take longer than that. Streaming sends headers at once
   * and the final NDJSON object still carries the timings.
   */
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 150 },
      messages: [...history, { role: 'user', content: 'Write a haiku about disk space.' }]
    })
  })

  let d = {}
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const obj = JSON.parse(line)
      if (obj.done) d = obj
    }
  }
  return {
    prompt: d.prompt_eval_count ?? 0,
    gen: +((d.eval_count / d.eval_duration) * 1e9).toFixed(2),
    prefill: d.prompt_eval_count
      ? Math.round((d.prompt_eval_count / d.prompt_eval_duration) * 1e9)
      : 0,
    tokens: d.eval_count ?? 0
  }
}

console.log(`${label}  (${MODEL})\n`)
console.log(`${'context'.padStart(8)} ${'gen tok/s'.padStart(10)} ${'prefill'.padStart(8)}`)
const rows = []
for (const words of [0, 400, 1000, 2000]) {
  const r = await run(words)
  rows.push(r)
  console.log(`${String(r.prompt).padStart(8)} ${String(r.gen).padStart(10)} ${String(r.prefill).padStart(8)}`)
}
const first = rows[0].gen
const last = rows[rows.length - 1].gen
console.log(
  `\nempty ${first} tok/s -> ${rows[rows.length - 1].prompt} tokens of context ${last} tok/s ` +
    `(${(100 * (1 - last / first)).toFixed(0)}% slower)`
)

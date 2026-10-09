/**
 * Compares two Ollama configurations without letting the machine's mood decide.
 *
 * A laptop does not hold still. Measuring A, then B, then comparing them gave
 * nonsense here: processor performance drifted from 158% of base clock on a cool
 * chip to 118% after twenty minutes of benchmarking, which is larger than any
 * effect being looked for. The first run of a pair always wins.
 *
 * So both configurations run on their own server, on different ports, and the
 * requests alternate. Thermal drift then lands on both equally and cancels out
 * of the comparison. Medians, not means, because one stalled request should not
 * decide an answer.
 *
 * Run with: node scripts/bench-ab.mjs <portA> <portB> [labelA] [labelB]
 */
const [portA = '11434', portB = '11435', labelA = 'A', labelB = 'B'] = process.argv.slice(2)
const MODEL = process.env.BENCH_MODEL ?? 'phi4-mini:3.8b'
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 4)

/** Context roughly the size of a real conversation with the preamble in it. */
function filler(words) {
  const out = []
  for (let i = 0; i < words; i++)
    out.push(`item${i} value${(i * 7919) % 1000} tag${(i * 104729) % 97}`)
  return out.join(' ')
}

const CONTEXT = filler(800)

async function once(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 120 },
      messages: [
        { role: 'user', content: `Here is a log, just acknowledge it:\n${CONTEXT}` },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'Write a haiku about disk space.' }
      ]
    })
  })
  let d = {}
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) {
        const obj = JSON.parse(line)
        if (obj.done) d = obj
      }
    }
  }
  return { gen: (d.eval_count / d.eval_duration) * 1e9, prompt: d.prompt_eval_count ?? 0 }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// Both warm before anything counts, so a model load lands on neither.
await once(portA)
await once(portB)

const a = []
const b = []
console.log(`${MODEL}, ${ROUNDS} alternating rounds\n`)
console.log(`${'round'.padStart(5)} ${labelA.padStart(22)} ${labelB.padStart(22)}`)
for (let i = 1; i <= ROUNDS; i++) {
  // Order swaps each round, so neither side always gets the cooler chip.
  let ra, rb
  if (i % 2) {
    ra = await once(portA)
    rb = await once(portB)
  } else {
    rb = await once(portB)
    ra = await once(portA)
  }
  a.push(ra.gen)
  b.push(rb.gen)
  console.log(
    `${String(i).padStart(5)} ${ra.gen.toFixed(2).padStart(22)} ${rb.gen.toFixed(2).padStart(22)}`
  )
}

const ma = median(a)
const mb = median(b)
console.log(`\n${labelA}: median ${ma.toFixed(2)} tok/s`)
console.log(`${labelB}: median ${mb.toFixed(2)} tok/s`)
const diff = (100 * (mb / ma - 1)).toFixed(1)
console.log(`\n${labelB} is ${diff > 0 ? '+' : ''}${diff}% against ${labelA}`)

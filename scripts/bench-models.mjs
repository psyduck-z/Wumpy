/**
 * Ranks installed Ollama models on the machine that will actually run them.
 *
 * Published benchmarks are run on hardware nobody here owns and on tasks Wumpy
 * never performs. This scores what matters for a tray assistant on a CPU-only
 * laptop: how long until words appear, whether the model reasons correctly,
 * whether it follows terse instructions, and whether it gets Wumpy's own rules
 * right — asking versus changing, and proposing a command rather than guessing
 * at machine state.
 *
 * Every check is machine-gradable. Nothing here is judged by reading it.
 *
 * Each case is run `--repeat` times and reported as a pass rate, because a
 * single run cannot tell a real improvement from sampling noise. Two prompt
 * experiments were wrongly called a win and a loss before this existed: on one
 * sweep the same model scored 4/6 and 6/6 on identical questions.
 *
 * Usage:
 *   node scripts/bench-models.mjs                  # every installed model
 *   node scripts/bench-models.mjs qwen3.5:4b ...   # just these
 *   node scripts/bench-models.mjs --quick          # skip the slow reasoning set
 *   node scripts/bench-models.mjs --repeat 3       # average over three runs
 */
import { build } from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const args = process.argv.slice(2)
const quick = args.includes('--quick')
const repeatAt = args.indexOf('--repeat')
const repeat = repeatAt === -1 ? 1 : Math.max(1, Number(args[repeatAt + 1]) || 1)
const only = args.filter((a, i) => !a.startsWith('--') && i !== repeatAt + 1)

/**
 * The prompts are imported from the app, never copied.
 *
 * They were copied once, and went stale the moment the real ones were trimmed:
 * the benchmark carried on scoring a prompt that had not shipped for several
 * commits, and reported a failure the app did not have.
 */
const promptBundle = join(process.cwd(), '.bench-prompts.mjs')
await build({
  entryPoints: ['src/shared/tiers.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: promptBundle,
  logLevel: 'error'
})
const tiers = await import(pathToFileURL(promptBundle).href)
rmSync(promptBundle, { force: true })

/** Live facts, as src/main/index.ts assembles them. */
const CONTEXT = [
  'Facts about right now. If the user asks about any of these, just state the answer.',
  '- Today is Tuesday, 7 October 2026.',
  '- The current tier is Fast.',
  '- This chat is titled "Speculative Fiction".',
  '- The user is on Windows.'
].join('\n')

const TIER = tiers.TIERS.fast
const SYS_CHAT = [
  TIER.systemPrompt,
  tiers.APP_PROMPT,
  tiers.NO_SHELL_PROMPT,
  tiers.ASK_PROMPT
].join('\n\n')
const SYS_SHELL = [
  TIER.systemPrompt,
  tiers.APP_PROMPT,
  tiers.READ_SHELL_PROMPT,
  tiers.SEARCH_PROMPT,
  tiers.ASK_PROMPT
].join('\n\n')
/** Worked turns the shell-capable tiers prepend. */
const SHOTS = tiers.shellExamples('read')

const hasCommand = (t) => /```wumpy-run(?:-cmd|-bash)?\s*\n([\s\S]*?)```/.test(t)
const commandBody = (t) => (t.match(/```wumpy-run(?:-cmd|-bash)?\s*\n([\s\S]*?)```/) ?? [])[1] ?? ''

/**
 * The test set. `check` returns true when the answer is acceptable.
 * `weight` lets a category count for more than its question count.
 */
const TESTS = [
  // ---- logic: deterministic, checkable, and the thing that actually blocks ----
  {
    group: 'logic',
    slow: true,
    ask: 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much does the ball cost? Answer with just the amount.',
    check: (t) => /(\$?0?\.05|5\s*cents|five\s*cents)/i.test(t) && !/\$?0?\.10\b/.test(t)
  },
  {
    group: 'logic',
    slow: true,
    ask: 'If it takes 5 machines 5 minutes to make 5 widgets, how long would 100 machines take to make 100 widgets? Answer with just the number of minutes.',
    check: (t) => /\b5\b/.test(t) && !/\b100\s*min/i.test(t)
  },
  {
    group: 'logic',
    slow: true,
    ask: 'I have 3 apples. I eat one, then buy a bag containing twice as many apples as I now have. How many apples do I have? Answer with just the number.',
    check: (t) => /\b6\b/.test(t)
  },
  {
    group: 'logic',
    slow: true,
    ask: 'Sort these numbers descending and reply with only the list, comma separated: 12, 7, 103, 7, 45, 9',
    check: (t) => /103\s*,\s*45\s*,\s*12\s*,\s*9\s*,\s*7\s*,\s*7/.test(t)
  },
  {
    group: 'logic',
    slow: true,
    ask: 'Which is larger, 9.11 or 9.9? Answer with just the number.',
    check: (t) => /9\.9(?!\d)/.test(t) && !/9\.11/.test(t.replace(/9\.9/g, ''))
  },

  // ---- instruction following: terse, exact format ----
  {
    group: 'instruction',
    ask: 'What is the capital of France? Reply with one word.',
    check: (t) => /paris/i.test(t) && t.trim().split(/\s+/).length <= 3
  },
  {
    group: 'instruction',
    ask: 'List exactly three primary colours as a comma separated list and nothing else.',
    check: (t) => {
      const parts = t.trim().replace(/\.$/, '').split(',')
      return parts.length === 3 && /red/i.test(t) && /blue/i.test(t)
    }
  },
  {
    group: 'instruction',
    ask: 'Reply with exactly the word PONG and nothing else.',
    check: (t) => /^\W*pong\W*$/i.test(t.trim())
  },
  {
    group: 'instruction',
    ask: 'Give me a PowerShell one-liner that lists files in the current folder. Code block only, no explanation.',
    check: (t) => /```/.test(t) && /(Get-ChildItem|\bls\b|\bdir\b)/i.test(t)
  },

  // ---- Wumpy rules: asking vs changing ----
  {
    group: 'wumpy',
    ask: 'what is this chat called?',
    check: (t) => /speculative fiction/i.test(t) && !/^\s*\/|use `\//i.test(t)
  },
  {
    group: 'wumpy',
    ask: 'what day is it today?',
    check: (t) => /tuesday/i.test(t) && !/^\s*\//.test(t.trim())
  },
  {
    group: 'wumpy',
    ask: 'rename this chat to Ideas',
    check: (t) => /\/rename/i.test(t)
  },
  {
    group: 'wumpy',
    ask: 'start a new chat',
    check: (t) => /\/new/i.test(t)
  },

  // ---- shell: check rather than guess, and include a reason ----
  {
    group: 'shell',
    shell: true,
    ask: 'is ollama installed on my pc?',
    check: (t) => hasCommand(t) && /^\s*#/m.test(commandBody(t))
  },
  {
    group: 'shell',
    shell: true,
    ask: 'how much free disk space do i have',
    check: (t) => hasCommand(t) && /^\s*#/m.test(commandBody(t))
  },
  {
    group: 'shell',
    shell: true,
    ask: 'what version of node am i running',
    check: (t) => hasCommand(t) && /node/i.test(commandBody(t))
  },
  {
    group: 'shell',
    shell: true,
    // Must NOT propose a command for general knowledge.
    ask: 'whats the capital of france',
    check: (t) => !hasCommand(t) && /paris/i.test(t)
  },
  {
    group: 'shell',
    shell: true,
    ask: 'explain what a mutex is in one sentence',
    check: (t) => !hasCommand(t) && /(lock|mutual|exclusi|thread|shared)/i.test(t)
  }
]

async function ask(model, system, prompt, numPredict) {
  const t0 = Date.now()
  let first = null
  let text = ''
  let evalCount = 0
  let evalDur = 0

  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        ...(system === SYS_SHELL ? SHOTS : []),
        { role: 'system', content: CONTEXT },
        { role: 'user', content: prompt }
      ],
      stream: true,
      keep_alive: '10m',
      options: { num_ctx: 4096, num_predict: numPredict, temperature: 0.2 }
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const l of lines) {
      if (!l.trim()) continue
      const j = JSON.parse(l)
      const c = j.message?.content
      if (c) {
        if (first === null) first = Date.now() - t0
        text += c
      }
      if (j.done) {
        evalCount = j.eval_count ?? 0
        evalDur = j.eval_duration ?? 0
      }
    }
  }
  return {
    text,
    first: first ?? Date.now() - t0,
    total: Date.now() - t0,
    tps: evalDur ? evalCount / (evalDur / 1e9) : 0
  }
}

async function installed() {
  const res = await fetch(`${HOST}/api/tags`)
  const body = await res.json()
  return (body.models ?? []).map((m) => ({ name: m.name, size: m.size }))
}

const models = only.length ? only.map((name) => ({ name, size: 0 })) : await installed()
const tests = quick ? TESTS.filter((t) => !t.slow) : TESTS
const results = []

console.log(`Benchmarking ${models.length} model(s) on ${tests.length} checks each.\n`)

for (const { name, size } of models) {
  process.stdout.write(`${name}\n`)
  const scores = {}
  const times = []
  let firsts = []
  let failed = []

  // Warm the model so load time never lands inside a measurement.
  try {
    await ask(name, 'You are a test.', 'hi', 4)
  } catch (err) {
    console.log(`  unavailable: ${err.message}\n`)
    continue
  }

  for (const t of tests) {
    const system = t.shell ? SYS_SHELL : SYS_CHAT
    let passes = 0

    for (let run = 0; run < repeat; run++) {
      let r
      try {
        r = await ask(name, system, t.ask, 350)
      } catch {
        r = { text: '', first: 0, total: 0, tps: 0 }
      }
      if (t.check(r.text)) passes++
      times.push(r.total)
      if (r.tps) firsts.push({ tps: r.tps, first: r.first })
    }

    scores[t.group] ??= { pass: 0, total: 0 }
    scores[t.group].total += repeat
    scores[t.group].pass += passes

    if (passes < repeat) failed.push(`${t.group}: ${t.ask.slice(0, 44)} (${passes}/${repeat})`)
    // A case that is sometimes right is worth seeing as such.
    process.stdout.write(passes === repeat ? '.' : passes === 0 ? 'x' : '~')
  }

  const tps = firsts.length ? firsts.reduce((a, b) => a + b.tps, 0) / firsts.length : 0
  const first = firsts.length ? firsts.reduce((a, b) => a + b.first, 0) / firsts.length : 0
  const passed = Object.values(scores).reduce((a, s) => a + s.pass, 0)
  const total = Object.values(scores).reduce((a, s) => a + s.total, 0)

  results.push({ name, size, scores, tps, first, passed, total })
  console.log(`  ${passed}/${total}  ${tps.toFixed(1)} tok/s  first word ${Math.round(first)}ms`)
  if (failed.length) console.log(`  missed: ${failed.slice(0, 4).join(' | ')}`)
  console.log()
}

/* ----------------------------------------------------------------- ranking */

// Quality is the pass rate. Speed is scored against a 1.5s first word, which is
// roughly where an overlay stops feeling instant. Both are capped at 1 so a
// very fast but useless model cannot win on speed alone.
const score = (r) => {
  const quality = r.total ? r.passed / r.total : 0
  const speed = Math.min(1, 1500 / Math.max(r.first, 1))
  return 0.7 * quality + 0.3 * speed
}

results.sort((a, b) => score(b) - score(a))

const groups = [...new Set(tests.map((t) => t.group))]
const head = ['model', 'overall', ...groups, 'tok/s', 'first word'].join(' | ')
const rows = results.map((r) => {
  const cells = groups.map((g) => (r.scores[g] ? `${r.scores[g].pass}/${r.scores[g].total}` : '-'))
  return [
    r.name,
    (score(r) * 100).toFixed(0),
    ...cells,
    r.tps.toFixed(1),
    `${Math.round(r.first)}ms`
  ].join(' | ')
})

console.log('='.repeat(78))
console.log('RANKING  (70% correctness, 30% responsiveness)\n')
console.log(head)
console.log(rows.join('\n'))

writeFileSync(
  'bench-results.json',
  `${JSON.stringify({ at: new Date().toISOString(), host: HOST, results }, null, 2)}\n`
)
console.log('\nwrote bench-results.json')

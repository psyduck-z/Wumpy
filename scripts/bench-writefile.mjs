/**
 * Does this model write a file that actually works?
 *
 * The question that matters for Wumpy is narrower than any benchmark: asked to
 * create a Python script, does it use the write block, and does what lands on
 * disk compile. phi4-mini passes this now, but only because the block removed
 * the shell quoting it could not handle - the Python it writes is still thin.
 *
 * Correctness is checked by compiling the result, not by reading it, because a
 * script that looks right and raises SyntaxError is the whole complaint.
 *
 * The tasks live in writetasks.mjs, shared with the cloud bench, so a local and
 * a hosted model are always asked exactly the same thing.
 *
 * Run with: node scripts/bench-writefile.mjs <model> [model...]
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { TASKS } from './writetasks.mjs'

const out = join(process.cwd(), '.wf-bundle.mjs')
await build({
  entryPoints: ['src/shared/writefile.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { readWriteRequest } = await import(pathToFileURL(out).href)

const tiersOut = join(process.cwd(), '.wf-tiers.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tiersOut,
  logLevel: 'error'
})
const T = await import(pathToFileURL(tiersOut).href)

const system = [T.VOICE_PROMPT, T.SHELL_PROMPT].filter(Boolean).join('\n\n')

async function ask(model, content) {
  const started = Date.now()
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: 8192, temperature: 0.2, num_predict: 900 },
      messages: [
        { role: 'system', content: system },
        ...T.shellExamples('full'),
        { role: 'user', content }
      ]
    })
  })
  let text = ''
  let done = {}
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const obj = JSON.parse(line)
      if (obj.message?.content) text += obj.message.content
      if (obj.done) done = obj
    }
  }
  return {
    text,
    seconds: (Date.now() - started) / 1000,
    tokPerSec: done.eval_duration ? (done.eval_count / done.eval_duration) * 1e9 : 0
  }
}

for (const model of process.argv.slice(2)) {
  console.log(`\n=== ${model} ===`)
  let usedBlock = 0
  let compiles = 0
  let substance = 0
  let seconds = 0
  let rates = []

  for (const task of TASKS) {
    const got = await ask(model, task.ask)
    seconds += got.seconds
    if (got.tokPerSec) rates.push(got.tokPerSec)

    const block = /```wumpy-write\n([\s\S]*?)```/.exec(got.text)
    if (!block) {
      console.log(`  no block        ${task.ask.slice(0, 44)}…`)
      continue
    }
    usedBlock++
    const { content } = readWriteRequest(block[1])

    const dir = mkdtempSync(join(tmpdir(), 'wumpy-wf-'))
    const file = join(dir, 'candidate.py')
    writeFileSync(file, content, 'utf8')
    const check = spawnSync('python', ['-I', '-m', 'py_compile', file], {
      encoding: 'utf8'
    })
    const ok = check.status === 0
    if (ok) compiles++

    // Compiling is not the same as doing the job; these are the things the task
    // cannot be solved without.
    const has = task.wants.every((w) => content.includes(w))
    if (ok && has) substance++

    console.log(
      `  ${ok ? 'compiles' : 'SYNTAX  '} ${has ? 'on-task' : 'thin   '} ` +
        `${String(content.split('\n').length).padStart(3)} lines  ` +
        `${got.seconds.toFixed(0)}s  ${task.ask.slice(0, 34)}…`
    )
    if (!ok) console.log(`      ${(check.stderr || '').trim().split('\n').slice(-2)[0] ?? ''}`)
  }

  const median = rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)] ?? 0
  console.log(
    `  -> ${usedBlock}/${TASKS.length} used the block, ${compiles}/${TASKS.length} compile, ` +
      `${substance}/${TASKS.length} on task, ${median.toFixed(1)} tok/s, ${seconds.toFixed(0)}s total`
  )
}

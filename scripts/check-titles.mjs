/**
 * Checks the repairs applied to model-written chat titles.
 *
 * Every case here came from real output. The one that prompted the rest: asking
 * "what are all the ollama ai models i have locally" produced the title
 * "OLLA MA AI MODELS" — shouted, and with a word split in half.
 *
 * Run with: npm run check:titles
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.title-check.bundle.mjs')
await build({
  entryPoints: ['src/main/titles.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { cleanTitle } = await import(pathToFileURL(out).href)

const CASES = [
  // raw model output, the question it described, what it should become
  ['OLLA MA AI MODELS', 'what are all the ollama ai models i have locally', 'Ollama AI Models'],
  ['SPECULATIVE FICTION', 'what is speculative fiction', 'Speculative Fiction'],
  ['Speculative Fiction', 'what is speculative fiction', 'Speculative Fiction'],
  ['Title: "Disk Usage."', 'how much disk space do i have', 'Disk Usage'],
  ['CPU core count', 'how much cores does this pc have', 'CPU Core Count'],
  // Identifiers and acronyms must survive untouched.
  ['CSS Centering', 'how do i center a div in css', 'CSS Centering'],
  ['Win+C Hotkey Problem', 'my app wont register Win+C', 'Win+C Hotkey Problem'],
  ['llama3.2 Comparison', 'compare llama3.2 models', 'llama3.2 Comparison'],
  // A word the model chose that is simply absent from the question must not be
  // glued to its neighbour.
  ['Quick Pasta Recipe', 'whats a good pasta sauce with tomatoes', 'Quick Pasta Recipe'],
  ['Cat Waking Habits', 'how do i stop my cat waking me at 5am', 'Cat Waking Habits'],
  ['Simple Marinara Sauce', 'whats a good pasta sauce', 'Simple Marinara Sauce']
]

let failed = 0
for (const [raw, question, want] of CASES) {
  const got = cleanTitle(raw, question)
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(raw).padEnd(24)} -> ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

rmSync(out, { force: true })
console.log(`\n${CASES.length - failed}/${CASES.length} titles repaired correctly`)
process.exit(failed === 0 ? 0 : 1)

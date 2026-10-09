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
  entryPoints: ['src/shared/titles.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { cleanTitle, shouldRetitle, titleSource } = await import(pathToFileURL(out).href)

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

/* ------------------------------------------------- when to rename it again */

const NL = String.fromCharCode(10)

let extra = 0

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  extra++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${JSON.stringify(got)}`)
}

// The schedule itself: 1, 2, 4, 8, 16 - renaming freely at the start and
// rarely once there is a conversation to go on.
const fired = []
let last = 0
for (let turns = 1; turns <= 20; turns++) {
  if (shouldRetitle(turns, last)) {
    fired.push(turns)
    last = turns
  }
}
check('the gaps double', fired, [1, 2, 4, 8, 16])

check('nothing to name before the first question', shouldRetitle(0, 0), false)
check('the first question names it', shouldRetitle(1, 0), true)
check('but only once', shouldRetitle(1, 1), false)
check('the second question renames it', shouldRetitle(2, 1), true)
check('the third does not', shouldRetitle(3, 2), false)
check('the fourth does', shouldRetitle(4, 2), true)

/**
 * A chat reopened from history is at whatever turn count it holds, and was
 * titled then. Five turns in, the next rename is at eight - not immediately,
 * which is what a power-of-two test on the turn count alone would have done
 * (5 is not a power of two, so it would never have qualified again either).
 */
check('a resumed chat waits for the next threshold', shouldRetitle(5, 5), false)
check('and reaches it at eight', shouldRetitle(8, 5), true)
check('a long resumed chat is not renamed at once', shouldRetitle(30, 30), false)
check('and is renamed at thirty-two', shouldRetitle(32, 30), true)

// Several turns can arrive between renders, so a count that stepped past a
// threshold must still fire.
check('a jump past a threshold still fires', shouldRetitle(6, 2), true)

/* --------------------------------------------------- what it is named from */

check(
  'every question, oldest first',
  titleSource(['first thing', 'second thing', 'third thing']),
  ['first thing', 'second thing', 'third thing'].join(NL)
)
check('blank turns are dropped', titleSource(['a', '   ', 'b']), ['a', 'b'].join(NL))
check('newlines inside a question are flattened', titleSource([`two${NL}lines`]), 'two lines')

// The background model is the small one, so a long chat cannot send it
// everything: questions are taken until the budget runs out.
const many = Array.from({ length: 40 }, (_, i) => `question number ${i} about something`)
const capped = titleSource(many)
check('and capped', capped.length <= 1200, true)
check('oldest kept, not newest', capped.startsWith('question number 0'), true)

rmSync(out, { force: true })
const total = CASES.length + extra
console.log(NL + `${total - failed}/${total} title checks correct`)
process.exit(failed === 0 ? 0 : 1)

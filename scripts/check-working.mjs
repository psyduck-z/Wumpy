/**
 * The search, folded away from the answer.
 *
 * Asked an analogy question and then an anagram, Wumpy "started listing out
 * all the freaking possibilities", then hit the output cap part-way through
 * the list — so what arrived was the search and no answer at the end of it.
 * Their ask: "if it's gonna try to do that even so, which I would not
 * recommend, at least compact it, saying like searching patterns."
 *
 * The text below is that reply, as it appeared. Two things have to hold at
 * once and they pull against each other: the run has to fold, and an
 * ordinary answer must come out exactly as it went in — this sits between
 * every message and the screen, so a false fold hides something real.
 *
 * Run with: npm run check:working
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.working-check.mjs')
await build({
  entryPoints: ['src/shared/working.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const W = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

const NL = String.fromCharCode(10)
const lines = (...parts) => parts.join(NL)

/* ------------------------------------------------- the reply that caused it */

const RAMBLE = lines(
  'My mistake. Let us look at the options again:',
  '',
  'Since you must replace one letter in RETAIL (6 letters) and rearrange them,',
  'the result must also have 6 letters. That leaves OFFICE or CHANGE.',
  '',
  "If you replace the 'I' in RETAIL with an 'O', you get RETAOL, which rearranges to ALTERO (not a word).",
  '',
  "Actually, if you replace the 'I' in RETAIL with an 'O' and the 'L' with a 'C', you get RETAOC. Wait, that's two letters.",
  '',
  "Let me try ALTER (from RETAIL minus I): that rearranges to ARTICLE. That's 7 letters.",
  '',
  'Let me re-examine the options. Is it ALTER? No, that is not an option.',
  '',
  'Could it be RETAIL -> RELATE? That is just rearranging.'
)

const folded = W.foldWorking(RAMBLE)
check('the ramble is split in two', folded.length, 2)
check('the part that was an answer stays out', folded[0].working, false)
check('and the search goes behind the line', folded[1].working, true)
/* Seven, not six: the letter-counting paragraph is working as well, and it
   is the one that reads most like an answer while being none of one. */
check(
  'the line says how much is behind it',
  W.foldLabel(folded[1].lines),
  'Working through possibilities · 7 lines'
)
check('one line of working is not "1 lines"', W.foldLabel(1), 'Working through possibilities · 1 line')

/* Nothing may be lost on the way. This sits between every message and the
   screen: a fold that drops a paragraph is worse than no fold. */
const back = folded
  .map((s) => s.body)
  .join(NL + NL)
  .split(NL)
  .filter((l) => l.trim())
check('and every line survives the fold', back, RAMBLE.split(NL).filter((l) => l.trim()))

/* -------------------------------------------------- what must NOT be folded */

/**
 * The ordinary answer, returned as it arrived.
 *
 * Identity rather than "close enough": every message in the transcript goes
 * through this, so the common path has to be the one it always was.
 */
const PLAIN = lines(
  'The answer is C, VEHICLE.',
  '',
  'Replace the A in RETAIL with a T and rearrange: LITTER, the covered chair',
  'carried on poles. It keeps all six letters, which the question requires.'
)
check('an ordinary answer is one segment', W.foldWorking(PLAIN).length, 1)
check('and it is the same text', W.foldWorking(PLAIN)[0].body, PLAIN)
check('empty text survives too', W.foldWorking('')[0].body, '')

/* A sentence of thinking out loud is not a search. The bar is a RUN. */
const ONE_ASIDE = lines(
  'Let me check that first.',
  '',
  'C: has 118 GB free of 465 GB, so about a quarter is left.'
)
check('one aside is left alone', W.foldWorking(ONE_ASIDE).length, 1)
const TWO = lines('Let me try the first one.', '', "Hmm, that's 7 letters.", '', 'So the answer is TRAILER.')
check('and so are two', W.foldWorking(TWO).length, 1)

/**
 * A fenced block is never cut, whatever it says inside.
 *
 * It can hold blank lines and it can hold the word "wait" — and half a
 * wumpy-run block is not a command card, it is grey text with a stray ```
 * under it, which is exactly the failure normaliseFences exists to prevent.
 */
const WITH_FENCE = lines(
  'Let me try that again.',
  '',
  'Hmm, that is not it either.',
  '',
  'Could it be the uninstall registry?',
  '',
  '```wumpy-run',
  '# Wait for the service to settle',
  'Get-Service -Name Spooler',
  '',
  'Start-Sleep -Seconds 1',
  '```',
  '',
  'That tells us whether it is running.'
)
const fenced = W.foldWorking(WITH_FENCE)
const whole = fenced.find((s) => s.body.includes('wumpy-run'))
check('the block stays in one piece', whole.body.split('```').length - 1, 2)
check('and is not folded away', whole.working, false)
check('the three attempts before it are', fenced[0].working, true)
check('and the sentence after it is not', fenced[fenced.length - 1].working, false)

/* The markers, one at a time, so a reworded one is visible here rather than
   as a fold that quietly stopped happening. */
check('a rejected candidate', W.isAttempt('RETAOL rearranges to ALTERO (not a word).'), true)
check('a letter count', W.isAttempt("That's 7 letters."), true)
check('a restart', W.isAttempt('Let me re-examine the options.'), true)
check('a correction', W.isAttempt("Wait, that's two letters."), true)
check('an arrow', W.isAttempt('RETAIL -> RELATE'), true)
check('a plain sentence is not', W.isAttempt('The answer is C, VEHICLE.'), false)
check('nor is a question to the user', W.isAttempt('Which folder did you mean?'), false)
/* An explanation that happens to use the word is prose, not an attempt. */
check(
  'nor a paragraph that merely mentions one',
  W.isAttempt(
    'Let me check is a phrase that appears in long explanations too, and this ' +
      'paragraph is one of those: it runs well past four hundred characters, ' +
      'which is the length at which a sentence stops being an abandoned attempt ' +
      'and starts being the body of an answer that the reader actually wants to ' +
      'see on screen rather than hidden behind a disclosure they have to click ' +
      'to open, and folding it would hide real content.'
  ),
  false
)

/* ---------------------------------------------------------------- the wiring */

const message = readFileSync('src/renderer/src/components/Message.tsx', 'utf8')
check('the transcript folds', /foldWorking\(shown\)\.map/.test(message), true)
check('behind a shut disclosure', /useState\(false\)/.test(message), true)
check('and says what it is hiding', /foldLabel\(lines\)/.test(message), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of`} working checks`)
process.exit(failures === 0 ? 0 : 1)

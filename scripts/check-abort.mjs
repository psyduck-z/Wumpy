/**
 * Whether an interrupted turn hands the question back.
 *
 * The risk here is destroying an answer. Getting the boundary wrong in one
 * direction is a small annoyance - the prompt is not returned and the user
 * presses up. Getting it wrong in the other deletes a reply the user could
 * see, along with the question that produced it, which is not recoverable.
 *
 * Run with: npm run check:abort
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.abort-check.mjs'
await build({
  entryPoints: ['src/renderer/src/abort.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const A = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const at = (over) => ({ elapsedMs: 100, outputChars: 0, startedBlock: false, ...over })

/* The case it is for: sent it, changed my mind, nothing has happened. */
check('bailing out immediately returns it', A.returnsThePrompt(at({})), true)
check('a word or two in, still returns it', A.returnsThePrompt(at({ outputChars: 20 })), true)

/* Past the window the user is stopping an answer, not withdrawing a question. */
check('past the window it does not', A.returnsThePrompt(at({ elapsedMs: A.BAIL_WINDOW_MS })), false)
check('well past, certainly not', A.returnsThePrompt(at({ elapsedMs: 30_000 })), false)
check('just inside the window still does', A.returnsThePrompt(at({ elapsedMs: A.BAIL_WINDOW_MS - 1 })), true)

/* Enough text on screen to read is an answer, even if it came fast. */
check('a real answer is never thrown away', A.returnsThePrompt(at({ outputChars: A.BAIL_CHARS })), false)
check('one character under is still a bail', A.returnsThePrompt(at({ outputChars: A.BAIL_CHARS - 1 })), true)

/**
 * A proposed command arrives early and is the useful part of the answer.
 * Deleting it to hand back a prompt would be the worst outcome here.
 */
check('a started block is work', A.returnsThePrompt(at({ startedBlock: true })), false)
check('even immediately', A.returnsThePrompt(at({ elapsedMs: 1, startedBlock: true })), false)

/*
 * The window depends on how much the model has done, which is the whole
 * point: waiting is cheap to throw away and text on screen is not.
 */
check('three seconds while nothing has arrived', A.bailWindowFor(0), 3000)
check('and that is the ceiling', A.BAIL_WINDOW_MS, 3000)
check('half an answer in, half the window', A.bailWindowFor(A.BAIL_CHARS / 2), 1500)
check('a full answer leaves none of it', A.bailWindowFor(A.BAIL_CHARS), 0)
check('nor does more than one', A.bailWindowFor(10_000), 0)
check('but there is always a second to react', A.bailWindowFor(A.BAIL_CHARS - 1), A.BAIL_FLOOR_MS)
check('the window never grows with more text', [0, 60, 120, 180, 239].map(A.bailWindowFor), [
  3000, 2250, 1500, 1000, 1000
])
/* The behaviour that comes out of it, at the two moments that differ. */
check(
  'thinking for 2.9 seconds still returns the prompt',
  A.returnsThePrompt(at({ elapsedMs: 2900, outputChars: 0 })),
  true
)
check(
  'but answering for 2.9 seconds does not',
  A.returnsThePrompt(at({ elapsedMs: 2900, outputChars: 150 })),
  false
)
check(
  'and a second in with text on screen still does',
  A.returnsThePrompt(at({ elapsedMs: 900, outputChars: 150 })),
  true
)

check('a fence is detected', A.hasBlock('here you go' + String.fromCharCode(10) + '```wumpy-run'), true)
check('prose is not', A.hasBlock('just some words'), false)
check('and neither is nothing', A.hasBlock(''), false)

console.log(`${String.fromCharCode(10)}${count - failed}/${count} abort checks correct`)
process.exit(failed === 0 ? 0 : 1)

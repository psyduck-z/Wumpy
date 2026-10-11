/**
 * How much of a long conversation goes in the page.
 *
 * The arithmetic is trivial and the failure mode is not: an off-by-one in
 * firstShown either hides the newest message or renders the whole history,
 * and the second one is invisible until the session is long enough to lag.
 *
 * Run with: npm run check:transcript
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.transcript-check.mjs'
await build({
  entryPoints: ['src/renderer/src/transcript.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const T = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const CAP = T.KEEP_RENDERED

/* A short conversation is never folded, whatever the arithmetic says. */
check('an empty chat shows from the start', T.firstShown(0, 0), 0)
check('one message shows', T.firstShown(1, 0), 0)
check('exactly the cap still shows all of it', T.firstShown(CAP, 0), 0)
check('and is not folded', T.foldsTranscript(CAP, 0), false)

/* One over the cap: the oldest drops out of the page, nothing else changes. */
check('one over drops the oldest', T.firstShown(CAP + 1, 0), 1)
check('hidden counts that one', T.hiddenCount(CAP + 1, 0), 1)
/**
 * But it is NOT announced yet. A transcript that sprouts "1 earlier message"
 * reads as a bug, and the saving at that size is nothing.
 */
check('a single hidden message is not announced', T.foldsTranscript(CAP + 1, 0), false)
check('nor are a few', T.foldsTranscript(CAP + T.FOLD_MARGIN, 0), false)
check('one past the margin is', T.foldsTranscript(CAP + T.FOLD_MARGIN + 1, 0), true)

/* The window is always the END of the conversation: the newest message must
 * be in the page or the user cannot see the answer being written. */
for (const total of [1, CAP, CAP + 1, 500, 5000]) {
  const start = T.firstShown(total, 0)
  if (start >= total && total > 0) {
    failed++
    count++
    console.log(`FAIL ${total} messages hid the newest one`)
  }
}
check('a long chat renders only the window', 500 - T.firstShown(500, 0), CAP)
check('and a very long one renders the same', 5000 - T.firstShown(5000, 0), CAP)

/* Revealing opens it in steps rather than all at once. */
check('revealing once shows a step more', 500 - T.firstShown(500, T.REVEAL_STEP), CAP + T.REVEAL_STEP)
check('and the hidden count drops by it', T.hiddenCount(500, T.REVEAL_STEP), 500 - CAP - T.REVEAL_STEP)
check(
  'revealing past the start stops at the start',
  T.firstShown(10, 1000),
  0
)
check('and folds away once nothing is hidden', T.foldsTranscript(10, 1000), false)
/* A negative reveal should not be able to hide MORE than the default. */
check('a nonsense reveal cannot hide more', T.firstShown(500, -999), 500 - CAP)

console.log(`${String.fromCharCode(10)}${count - failed}/${count} transcript checks correct`)
process.exit(failed === 0 ? 0 : 1)

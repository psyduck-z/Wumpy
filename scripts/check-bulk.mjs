/**
 * Folding a wall of text, and putting it back.
 *
 * Two separate jobs share this module and would drift apart if they did not:
 * what the model writes, folded in the transcript, and what the user pastes,
 * folded in the box. The second one carries a real risk - the marker is what
 * gets edited and the full text is what must be sent, so a substitution bug
 * silently sends the model a literal "[pasted #1]" instead of the log the
 * user meant it to read.
 *
 * Run with: npm run check:bulk
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.bulk-check.mjs'
await build({
  entryPoints: ['src/shared/bulk.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const B = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const LF = String.fromCharCode(10)
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

/* ------------------------------------------------------------- measuring */

check('an empty string is nothing', B.measure(''), { words: 0, lines: 0, chars: 0 })
check('one word on one line', B.measure('hello'), { words: 1, lines: 1, chars: 5 })
check(
  'three lines counted as three',
  B.measure(['a', 'b', 'c'].join(LF)).lines,
  3
)
/* Trailing newlines are how a file ends; counting them as a line makes every
 * fold claim one more than the editor shows. */
check('a trailing newline is not a line', B.measure('a' + LF).lines, 1)
check('nor is trailing whitespace', B.measure('a' + LF + LF + '   ').lines, 1)
check('words split on any whitespace', B.measure('a  b' + LF + 'c').words, 3)

/* ------------------------------------------------------------ the summary */

check('reads as the user sees it', B.summarise(['one two', 'three'].join(LF)), '3 words, 2 lines')
check('singulars are singular', B.summarise('one'), '1 word, 1 line')
/* A 1200-line file reading "1200 lines" is harder to take in at a glance. */
check('thousands get a comma', B.summarise(Array(1200).fill('w').join(LF)), '1,200 words, 1,200 lines')

/* ------------------------------------------------------------ thresholds */

const lines = (n) => Array(n).fill('x').join(LF)
check('a short snippet stays open', B.foldsCode(lines(10)), false)
check('and so does one exactly at the limit', B.foldsCode(lines(B.CODE_LINES)), false)
check('one line over folds', B.foldsCode(lines(B.CODE_LINES + 1)), true)
check('a long single line folds on characters', B.foldsCode('x'.repeat(B.CODE_CHARS + 1)), true)

check('a two-line paste stays', B.foldsPaste(lines(2)), false)
/* Lower than code on purpose: a paste has nothing to read in it. */
check('a paste folds sooner than code', B.PASTE_LINES < B.CODE_LINES, true)
check('a nine-line paste folds', B.foldsPaste(lines(B.PASTE_LINES + 1)), true)

/* ------------------------------------------- putting the paste back ------ */

const LOG = ['line one', 'line two', 'line three'].join(LF)

check('a marker is replaced by the real text', B.expandPastes(B.pasteMarker(0), [LOG]), LOG)
check(
  'with the words around it kept',
  B.expandPastes(`look at ${B.pasteMarker(0)} please`, [LOG]),
  `look at ${LOG} please`
)
check(
  'two pastes do not get muddled',
  B.expandPastes(`${B.pasteMarker(1)} then ${B.pasteMarker(0)}`, ['FIRST', 'SECOND']),
  'SECOND then FIRST'
)
/**
 * The one that bites. Marker 1 contains no substring of marker 10, but a
 * naive loop that replaced "[pasted #1]" first would corrupt "[pasted #10]"
 * if the markers were not whole tokens. Eleven pastes is absurd and the cost
 * of being wrong is a mangled message, so it is pinned.
 */
check(
  'ten pastes substitute correctly',
  B.expandPastes(B.pasteMarker(9), Array.from({ length: 10 }, (_, i) => `BODY${i}`)),
  'BODY9'
)
check(
  'a marker the user deleted is simply gone',
  B.expandPastes('nothing here', [LOG]),
  'nothing here'
)
/* Typed by hand, with nothing pasted: it has to stay literal rather than
 * expanding into someone else's paste or throwing. */
check('an invented marker is left alone', B.expandPastes('[pasted #3]', [LOG]), '[pasted #3]')
check('the same marker twice expands twice', B.expandPastes(`${B.pasteMarker(0)}${B.pasteMarker(0)}`, ['AB']), 'ABAB')

/**
 * A slot emptied by unfolding must not renumber the others.
 *
 * The marker IS the index, so removing one from the middle of the list would
 * make every later marker expand into the wrong text - the kind of bug that
 * sends someone else's log to the model and looks like nothing at all on
 * screen. The composer blanks the slot instead, so this is the shape that
 * has to keep working.
 */
check(
  'a blanked slot leaves the others pointing right',
  B.expandPastes(`${B.pasteMarker(0)} ${B.pasteMarker(2)}`, ['FIRST', '', 'THIRD']),
  'FIRST THIRD'
)
check(
  'and an unfolded marker is gone from the text anyway',
  B.expandPastes('already unfolded here', ['', 'SECOND']),
  'already unfolded here'
)

console.log(`${LF}${count - failed}/${count} bulk-text checks correct`)
process.exit(failed === 0 ? 0 : 1)

/**
 * Which visual row the caret is on, which is not which line of text.
 *
 * Reported: recall a previous message, press Up to reach its first line and
 * edit it, and instead of the caret moving the box jumps to an older entry.
 * "when you confirm that you want this... the previous message history, and
 * you try to move up to edit the first line, it switches, it uses the
 * history one and thinks you're doing that."
 *
 * The test was `no newline before the caret`, which finds the first LOGICAL
 * line. In a 440px composer a fifty-character message already wraps across
 * three rows with no newline in it anywhere, so the caret was called
 * "first line" while sitting on the third row. Every Up recalled. Down had
 * the same fault at the bottom, which is why it seemed not to navigate at
 * all.
 *
 * The measuring needs a browser. The decision made from the measurements
 * does not, and the decision is where the off-by-one lives - so that is
 * what is pinned here, with the numbers a real 440px composer produces.
 *
 * Run with: npm run check:caret
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.caret-check.mjs'
await build({
  entryPoints: ['src/renderer/src/caret.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const C = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
/** 14px text at 1.55 line-height, which is what the composer uses. */
const LH = 21.7

/* ------------------------------------------------------- one row of text */

/*
 * Both ends at once, and that matters: an empty or short box is the common
 * case, and Up must reach the last message on the FIRST press rather than
 * spending one moving a caret that has nowhere to go.
 */
check('an empty box is both first and last row', C.rowFlags({ caretTop: 0, lineHeight: LH, totalHeight: LH }), { first: true, last: true })
check('a short one-row draft likewise', C.rowFlags({ caretTop: 0, lineHeight: LH, totalHeight: LH }), { first: true, last: true })

/* --------------------------------------- a wrapped message, three rows */

/*
 * The reported bug. One logical line, no newline anywhere in it, wrapped
 * across three rows by a narrow panel. The old test said "first line" at
 * every one of these.
 */
const THREE = LH * 3
check('caret on the top row of a wrapped line', C.rowFlags({ caretTop: 0, lineHeight: LH, totalHeight: THREE }), { first: true, last: false })
check('caret on the middle row is neither', C.rowFlags({ caretTop: LH, lineHeight: LH, totalHeight: THREE }), { first: false, last: false })
check('caret on the last row is only last', C.rowFlags({ caretTop: LH * 2, lineHeight: LH, totalHeight: THREE }), { first: false, last: true })

/*
 * Which is the whole fix: recall puts the caret at the end, so the caret
 * starts on the last row, and Up there must MOVE rather than recall.
 */
check('Up from where recall leaves the caret does not recall', C.rowFlags({ caretTop: LH * 2, lineHeight: LH, totalHeight: THREE }).first, false)
check('and Down from there still reaches newer history', C.rowFlags({ caretTop: LH * 2, lineHeight: LH, totalHeight: THREE }).last, true)

/* ------------------------------------------------------- rounding slack */

/*
 * Line heights are fractional - 14 x 1.55 is 21.7 - so after a few rows the
 * caret's top is never a clean multiple. A strict comparison puts the last
 * row off by one pixel and loses Down entirely.
 */
check('a sub-pixel above the first row still counts as first', C.rowFlags({ caretTop: 0.4, lineHeight: LH, totalHeight: THREE }).first, true)
check('a sub-pixel short of the bottom still counts as last', C.rowFlags({ caretTop: LH * 2 - 0.3, lineHeight: LH, totalHeight: THREE }).last, true)
check('but a whole row above the bottom does not', C.rowFlags({ caretTop: LH, lineHeight: LH, totalHeight: THREE }).last, false)
check('and a whole row below the top does not', C.rowFlags({ caretTop: LH, lineHeight: LH, totalHeight: THREE }).first, false)

/* ----------------------------------------------- a tall wrapped recall */

/* Ten rows, which a recalled paragraph easily reaches in this panel. */
const TEN = LH * 10
check('the top of a ten-row recall is first', C.rowFlags({ caretTop: 0, lineHeight: LH, totalHeight: TEN }), { first: true, last: false })
check('row five is neither end', C.rowFlags({ caretTop: LH * 5, lineHeight: LH, totalHeight: TEN }), { first: false, last: false })
check('the bottom is last', C.rowFlags({ caretTop: LH * 9, lineHeight: LH, totalHeight: TEN }), { first: false, last: true })

/* --------------------------------------------------------- degenerate */

/* A line height of zero would divide the whole box into one row; better to
   behave like a single-row box than to trap the caret. */
check('a zero line height does not trap the arrows', C.rowFlags({ caretTop: 0, lineHeight: 0, totalHeight: 100 }), { first: true, last: true })

/* ------------------------------------------- measured on the real composer */

/*
 * Taken from the live panel, not invented: a 322px composer, 21.7px rows,
 * and a 97-character message with NO newline in it wrapping to three rows.
 * The old logical-line test called all three of these "the first line".
 *
 * offsetTop is measured from the mirror's border box and so includes its
 * 10px top padding, while the height has the padding taken out. Those raw
 * numbers are the ones the code must get right.
 */
const PAD = 10
const real = (offsetTop) =>
  C.rowFlags({ caretTop: offsetTop - PAD, lineHeight: 21.7, totalHeight: 65 })

check('offsetTop 10 (row 1 of 3) is the first row', real(10), { first: true, last: false })
check('offsetTop 32 (row 2 of 3) is neither', real(32), { first: false, last: false })
check('offsetTop 53 (row 3 of 3) is the last row', real(53), { first: false, last: true })

/*
 * And the thing that nearly shipped: without taking the padding off,
 * offsetTop 10 on the first row passes only because 10 is under half of
 * 21.7. A padding of 12 would have stopped Up reaching the history at all.
 */
const unpadded = (offsetTop) => C.rowFlags({ caretTop: offsetTop, lineHeight: 21.7, totalHeight: 65 })
check('raw offsetTop on row 1 passes only by luck', unpadded(10).first, true)
check('and a 12px padding would have broken it', unpadded(12).first, false)
check('taking the padding off fixes it for any padding', C.rowFlags({ caretTop: 12 - 12, lineHeight: 21.7, totalHeight: 65 }).first, true)

const caretSrc = readFileSync('src/renderer/src/caret.ts', 'utf8')
check('the padding really is subtracted', /marker\.offsetTop - padTop/.test(caretSrc), true)
check('from the height too', /scrollHeight - padTop - padBottom/.test(caretSrc), true)

/* ------------------------------------------------------------ the wiring */

const composer = readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
check('the composer measures rows', /caretRows\(el\)/.test(composer), true)
check('Up uses the first row', /ArrowUp[^\n]*rows\.first/.test(composer), true)
check('Down uses the last row', /ArrowDown[^\n]*rows\.last/.test(composer), true)
check('the logical-line test is gone', /atFirstLine|atLastLine/.test(composer), false)

const caret = readFileSync('src/renderer/src/caret.ts', 'utf8')
check('a selection is left to the browser', /selectionStart !== el\.selectionEnd/.test(caret), true)
check('the mirror copies the wrap-deciding styles', /overflowWrap/.test(caret) && /wordBreak/.test(caret), true)
check('and the real client width, not the styled one', /el\.clientWidth/.test(caret), true)
check('the text after the caret is measured too', /after\.length/.test(caret), true)
check('a failed measurement falls back rather than dying', /catch[\s\S]{0,400}includes\(NL\)/.test(caret), true)

console.log(`${NL}${count - failed}/${count} caret checks passed`)
if (failed) process.exit(1)

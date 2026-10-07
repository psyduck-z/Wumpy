/**
 * Checks walking back through what the user has typed.
 *
 * The part that is easy to get wrong is the draft: pressing Up to see what you
 * asked earlier, and losing the sentence you were halfway through, is worse
 * than having no history at all. The walk is asserted end to end, including
 * coming back down to the draft and finding it intact.
 *
 * Run with: npm run check:history
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.history-check.mjs')
await build({
  entryPoints: ['src/renderer/src/history.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { HistoryWalk } = await import(pathToFileURL(out).href)

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(40)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

/* ------------------------------------------------------- an empty history */

const empty = new HistoryWalk()
check('Up with nothing recorded', empty.older('draft'), null)
check('Down before any Up', empty.newer(), null)

/* ------------------------------------------------------------- a full walk */

const w = new HistoryWalk(['first question', 'second question', 'third question'])
check('Up from a half-written draft', w.older('half writ'), 'third question')
check('browsing, having walked', w.browsing, true)
check('Up again', w.older('ignored'), 'second question')
check('Up again', w.older('ignored'), 'first question')
check('Up at the oldest stays put', w.older('ignored'), null)
check('Down', w.newer(), 'second question')
check('Down', w.newer(), 'third question')
check('Down restores the draft', w.newer(), 'half writ')
check('no longer browsing', w.browsing, false)
check('Down past the draft', w.newer(), null)

/* ---------------------------------------------------------------- details */

// The draft is whatever was in the box at the first Up, not at the last one.
const d = new HistoryWalk(['a', 'b'])
d.older('my draft')
d.older('not this')
check('the draft is taken once', d.newer(), 'b')
check('and returned unchanged', d.newer(), 'my draft')

// Sending resets the walk, so Up starts from the newest again.
const s = new HistoryWalk(['a', 'b'])
s.older('')
s.push('c')
check('sending leaves the walk', s.browsing, false)
check('Up after sending is the newest', s.older(''), 'c')

// Asking the same thing twice should not mean pressing Up twice to get past it.
const r = new HistoryWalk(['a', 'b'])
r.push('a')
check('a repeat moves to the end', r.all(), ['b', 'a'])
check('Up finds it once', r.older(''), 'a')
check('Up again finds the other', r.older(''), 'b')

// Blank input is not worth recalling.
const blank = new HistoryWalk(['a'])
blank.push('   ')
check('whitespace is not recorded', blank.all(), ['a'])

rmSync(out, { force: true })

const total = 20
console.log(`\n${total - failed}/${total} input-history checks correct`)
process.exit(failed === 0 ? 0 : 1)

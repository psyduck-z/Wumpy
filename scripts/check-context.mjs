/**
 * The notes Wumpy carries between chats.
 *
 * Every conversation starts from nothing, which is why the prompt has to
 * forbid promising to remember anything. This is the one exception, and the
 * thing that makes it safe to have is that it is small, owned by the user,
 * and honest about being clipped - a note that half arrives and says so is
 * better than one that quietly loses its last line.
 *
 * ContextStore imports electron for the userData path, so the pure parts
 * are exercised here through a stub rather than left untested.
 *
 * Run with: npm run check:context
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'wumpy-context-'))

// A stub for electron's app.getPath, so the real file logic runs against a
// temporary folder instead of the user's.
const shim = join(dir, 'electron.mjs')
writeFileSync(shim, `export const app = { getPath: () => ${JSON.stringify(dir)} }${NL}`)

const out = join(process.cwd(), '.context-check.mjs')
await build({
  entryPoints: ['src/main/context.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { electron: shim }
})
const { ContextStore, MAX_CONTEXT_CHARS } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const notes = new ContextStore()

/* ------------------------------------------------------- nothing, at first */

check('empty before anything is written', notes.read(), '')
check('and contributes no facts', notes.forPrompt(), [])

/* ------------------------------------------------------------- remembering */

notes.add('I prefer celsius')
check('one note is kept', notes.read(), '- I prefer celsius')
notes.add('my projects live on D:')
check('a second is appended, not replacing', notes.read().split(NL).length, 2)

const facts = notes.forPrompt()
check('it reaches the facts block', facts.some((l) => l.includes('celsius')), true)
check('and the second one too', facts.some((l) => l.includes('D:')), true)

/**
 * Labelled as the user's, not as instruction. Command output is data and so
 * is this: a note saying "always delete without asking" is a preference to
 * weigh, not a rule that outranks the safety the prompt carries.
 */
check(
  'it is introduced as theirs, not as orders',
  facts.some((l) => l.includes('theirs, not instructions')),
  true
)
check('and says it outranks nothing about safety', facts.some((l) => /outrank/.test(l)), true)

/* ---------------------------------------------------------------- the cap */

/**
 * Re-sent on every single turn, because nothing is remembered on the other
 * end - so a page of notes is a page of tokens on every message, forever.
 * The cap is enforced rather than advised.
 */
notes.write('x'.repeat(MAX_CONTEXT_CHARS + 500))
check('a long note is reported as truncated', notes.truncated(), true)
const clipped = notes.forPrompt().join(NL)
check('and what is sent is capped', clipped.length < MAX_CONTEXT_CHARS + 400, true)
check('and it admits to being clipped', /only the first part is shown/.test(clipped), true)

notes.write('short')
check('a short one is not truncated', notes.truncated(), false)
check('and says nothing about clipping', /only the first part/.test(notes.forPrompt().join(NL)), false)

/* --------------------------------------------------------------- forgetting */

notes.clear()
check('clearing empties it', notes.read(), '')
check('and removes the file rather than leaving a blank one', existsSync(notes.path()), false)
check('and it contributes nothing again', notes.forPrompt(), [])

// Adding nothing is refused rather than writing an empty bullet.
const empty = notes.add('   ')
check('an empty note is refused', empty.ok, false)
check('and nothing is written', notes.read(), '')

/* ------------------------------------------------------- what it looks like */

notes.add('call me Sam')
check('the file is plain markdown the user can open', readFileSync(notes.path(), 'utf8').trim(), '- call me Sam')
notes.clear()

rmSync(dir, { recursive: true, force: true })
console.log(`${NL}${count - failed}/${count} context checks correct`)
process.exit(failed === 0 ? 0 : 1)

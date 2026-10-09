/**
 * Telling a command that never ran apart from one that found nothing.
 *
 * Asked "do I have spotify installed", Wumpy proposed a check, the check
 * failed to parse, and the model answered "Spotify is not installed" - then
 * "I am certain". Spotify was in the Start menu.
 *
 * The prompt was one cause. The other was this app: every finished command
 * ended its report with "Answer the original question from this output, in
 * words", and on a syntax error that is an instruction to conclude something
 * from an error message. Wumpy asked for the mistake and then the model made
 * it.
 *
 * The stderr strings below are real, captured from powershell.exe on this
 * machine rather than imagined, because the whole value of this check is that
 * it matches what PowerShell actually says.
 *
 * Run with: node scripts/check-parsefail.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.parsefail-check.mjs')
await build({
  entryPoints: ['src/shared/parsefail.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const P = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

const r = (stdout, stderr, exitCode) => ({ stdout, stderr, exitCode })

/* ------------------------------------------- commands that never ran */

// Captured: a command wrapped onto two lines, losing its trailing comma.
check(
  'a trailing-comma continuation that broke',
  P.neverRan(
    r(
      '',
      "Missing expression after ',' in pipeline element.\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n    + FullyQualifiedErrorId : MissingExpression",
      1
    )
  ),
  true
)
// Captured: -ErrorAction left on its own line became a command of its own.
check(
  'a parameter orphaned onto its own line',
  P.neverRan(
    r('', "-ErrorAction : The term '-ErrorAction' is not recognized as the name of a cmdlet", 1)
  ),
  true
)
check('a plain parser error', P.neverRan(r('', 'ParserError: unexpected something', 1)), true)
check(
  'an unexpected token',
  P.neverRan(r('', 'Unexpected token "}" in expression or statement.', 1)),
  true
)
check('a missing argument', P.neverRan(r('', "Missing an argument for parameter 'Path'.", 1)), true)

/* --------------------------------------- commands that DID run */

// The one that matters most: the check worked and the app is simply absent.
// Calling this "never ran" would throw away a real answer.
check('an empty result from a command that ran', P.neverRan(r('', '', 0)), false)
check('success with output', P.neverRan(r('Spotify', '', 0)), false)
// A non-zero exit is a result, not a parse failure.
check('a command that ran and failed', P.neverRan(r('', 'Access is denied.', 1)), false)
check(
  'a file that is not there',
  P.neverRan(r('', "Cannot find path 'C:\\nope' because it does not exist.", 1)),
  false
)
// Printed something before erroring, so it reached the system.
check(
  'partial output then an error',
  P.neverRan(r('Spotify', 'ParserError: later in the script', 1)),
  false
)

/* ------------------------------------------- what the model is told */

const ending = P.NEVER_RAN_ENDING.join(' ')
check('it says the command did not run', /did NOT run/.test(ending), true)
check('and that it answers nothing', /told you NOTHING/.test(ending), true)
check('and is not a negative result', /not a negative result/.test(ending), true)
// The opposite of the ordinary ending, and deliberately so: a command that
// ran must not be proposed again, and one that never ran should be.
check('it asks for the command again, as one line', /again as ONE line/.test(ending), true)
check('and forbids answering from it', /Do not answer the original question/.test(ending), true)

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the report uses it', app.includes('NEVER_RAN_ENDING'), true)
// The header said "I ran that command" over the top of "that command did NOT
// run", which is the app contradicting itself in the same message.
check('and does not claim to have run it', app.includes('That command could not run.'), true)
check(
  'the ordinary ending still says to answer from the output',
  app.includes('Answer the original'),
  true
)

console.log(failures ? `\n${failures} parse-failure checks FAILED` : '\nall parse-failure checks')
process.exitCode = failures ? 1 : 0

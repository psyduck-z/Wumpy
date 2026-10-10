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

/* ------------------------- a command that ran and failed */

/**
 * Asked to open Spotify, the model proposed Start-Process "Spotify", which
 * fails because the app is not on PATH - and concluded "Spotify is not
 * installed", two messages after it had correctly established that Spotify
 * IS installed. One failed command overturned a fact it had already proved.
 *
 * The ordinary ending was pushing that: "Do not propose it again. Answer the
 * original question from this output." For a failure, the second sentence
 * asks for a conclusion the output cannot support and the first reads as
 * stop. The user's words were "make it keep on trying, and then return
 * failure", which is exactly the right shape.
 */
const failed = P.FAILED_ENDING.join(' ')
check('it says the command failed', /ran and FAILED/.test(failed), true)
check('not to repeat the same one', /Do not send the SAME command again/.test(failed), true)
check('but explicitly not to give up', /do not give up/.test(failed), true)
check(
  'it asks for another way',
  /another way to do what the user actually wanted/.test(failed),
  true
)
// The specific error: a failed launch is not proof the app is absent.
check(
  'a failure is about the command, not the world',
  /does not\s+prove the thing is missing/.test(failed),
  true
)
check('and must not overturn an established fact', /Never contradict/.test(failed), true)
// "Keep trying" has to end somewhere, and saying what was tried is the point.
check('failure is reported only after trying', /once you have actually tried/.test(failed), true)
check('and says what was tried', /what you tried and what it said/.test(failed), true)

/* ------------------------- absent program vs mangled command ------------- */

/**
 * These two produce the same PowerShell sentence and mean opposite things.
 *
 * `The term 'X' is not recognized` arrives both when a command was wrapped
 * onto two lines and left a fragment behind, and when the program simply is
 * not installed. Treating them alike produced a loop: asked for the docker
 * version, the model proposed `docker --version`, Wumpy answered "that
 * command did NOT run and has told you NOTHING, send it again as one line",
 * and the model proposed it again. The answer was in the error all along.
 *
 * They are told apart by whether the unrecognised term is the command's own
 * head. Nothing else in the message distinguishes them.
 */
const NOT_RECOGNISED = (term) =>
  `${term} : The term '${term}' is not recognized as the name of a cmdlet, function, script file, or operable program.`

check(
  'an absent program is not a parse failure',
  P.neverRan({
    stdout: '',
    stderr: NOT_RECOGNISED('docker'),
    exitCode: 1,
    command: 'docker --version'
  }),
  false
)
check(
  'and is recognised as not being on PATH',
  P.notOnPath({ stderr: NOT_RECOGNISED('docker'), command: 'docker --version' }),
  true
)
// The captured wrapping failure: the fragment is not the head.
check(
  'an orphaned parameter still is a parse failure',
  P.neverRan({
    stdout: '',
    stderr: NOT_RECOGNISED('-ErrorAction'),
    exitCode: 1,
    command: 'Get-ChildItem C:/x'
  }),
  true
)
check(
  'and is not reported as a missing program',
  P.notOnPath({ stderr: NOT_RECOGNISED('-ErrorAction'), command: 'Get-ChildItem C:/x' }),
  false
)
// With no command to compare against, the cautious reading stands.
check(
  'without the command it stays a parse failure',
  P.neverRan({ stdout: '', stderr: NOT_RECOGNISED('docker'), exitCode: 1 }),
  true
)
// And the ending told to the model is the one that ends the loop.
const absent = P.commandFeedback({
  command: 'docker --version',
  shell: 'powershell',
  cwd: 'C:/Users/me',
  stdout: '',
  stderr: NOT_RECOGNISED('docker'),
  exitCode: 1,
  durationMs: 5,
  timedOut: false,
  truncated: false,
  readOnly: true
})
check('the report says it is not installed', absent.text.includes('not installed'), true)
check('and tells it not to try again', /Do NOT propose that command again/.test(absent.text), true)
check(
  'and not to read a version out of the error',
  absent.text.includes('Do not read a version number out of an error message'),
  true
)
// An app can be installed without being on PATH, which is a different
// question - the ending must not overreach into answering it.
check(
  'while allowing that an app may still be installed',
  absent.text.includes('still not be on PATH'),
  true
)

/* ------------------------------ output that was cut off ------------------ */

/**
 * The fence already ended with a truncation marker and the model read
 * straight past it: asked to list every installed program it presented the
 * first 3000 characters as the whole list, twice out of two. The ordinary
 * ending does not help - "answer the original question from this output" is
 * an invitation to treat what is there as all there is. So the report says
 * it in words.
 */
{
  const report = (stdout) =>
    P.commandFeedback({
      command: 'Get-ItemProperty HKLM:/Software/.../Uninstall/*',
      shell: 'powershell',
      cwd: 'C:/Users/me',
      stdout,
      stderr: '',
      exitCode: 0,
      durationMs: 50,
      timedOut: false,
      truncated: false,
      readOnly: true
    }).text

  const long = 'Program Name 12345'.repeat(400)
  check('a cut-off list says so', report(long).includes('CUT OFF'), true)
  check(
    'and forbids a total from it',
    /Do not give a total, a count/.test(report(long)),
    true
  )
  check(
    'and asks for a counting command instead',
    report(long).includes('propose a command that counts'),
    true
  )
  check('short output is left alone', report('two lines only').includes('CUT OFF'), false)
  // Exactly at the limit is not cut off.
  check('output at the limit is not flagged', report('x'.repeat(3000)).includes('CUT OFF'), false)
  check('one character over is', report('x'.repeat(3001)).includes('CUT OFF'), true)
}

/* ------------------------------ a version that is not one ---------------- */

/**
 * 0.0.0.0 is what Windows reports for a binary with no version resource.
 * Get-Command prints it in the Version column, and the model read it out:
 * "You have version 0.0.0.0 of Ollama", whose real version is 0.40.1. The
 * prompt forbade that already and one run in two did it anyway, so the
 * report now says it at the moment the figure is on screen.
 *
 * Scoped so it does not fire on an address. 10.0.0.0 and 192.168.0.0 both
 * contain the digits and neither is a version column.
 */
{
  const withOutput = (stdout) =>
    P.commandFeedback({
      command: 'Get-Command ollama',
      shell: 'powershell',
      cwd: 'C:/Users/me',
      stdout,
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      truncated: false,
      readOnly: true
    }).text.includes('is not a version')

  check('a bare 0.0.0.0 is flagged', withOutput('0.0.0.0'), true)
  check('and one in a Version column', withOutput('Version   0.0.0.0'), true)
  check('a real version is left alone', withOutput('0.40.1'), false)
  check('and so is an address', withOutput('10.0.0.0'), false)
  check('including a private one', withOutput('192.168.0.0'), false)
}

/* ------------------------------ refused, not answered -------------------- */

const NL = String.fromCharCode(10)

/**
 * The case that mattered most, because the wrong reading is a claim about
 * disk encryption.
 *
 * Without elevation, Get-BitLockerVolume prints the denial AND a second line
 * saying the drive "does not have an associated BitLocker volume" - which is
 * the module reporting what it can see from behind a locked door. The model
 * read the second line and told the user BitLocker was off.
 */
const DENIED = [
  'Get-CimInstance : Access denied',
  '    + CategoryInfo          : PermissionDenied: (root/cimv2) [Get-CimInstance], CimException',
  'Get-Win32EncryptableVolumeInternal : C: does not have an associated BitLocker volume.'
].join(NL)

const refused = P.commandFeedback({
  command: 'Get-BitLockerVolume -MountPoint C:',
  shell: 'powershell',
  cwd: 'C:/Users/me',
  stdout: '',
  stderr: DENIED,
  exitCode: 1,
  durationMs: 20,
  timedOut: false,
  truncated: false,
  readOnly: true
})
check('a permission error is recognised', P.needsElevation({ stderr: DENIED }), true)
check(
  'the report says it was refused',
  refused.text.includes('REFUSED for want of permission'),
  true
)
check('and that nothing was learned', refused.text.includes('You therefore know NOTHING'), true)
check(
  'and that the lines after it are unsafe to read',
  refused.text.includes('unsafe to read'),
  true
)
check(
  'and never to call a security setting off because of it',
  /NEVER report a security setting as off/.test(refused.text),
  true
)
// It must beat the ordinary failure ending, which would have invited exactly
// the wrong reading: "answer the original question from this output".
check(
  'it takes precedence over the failed ending',
  !refused.text.includes(P.FAILED_ENDING[0]),
  true
)
// A denial can arrive alongside real output when only part of a query was
// allowed, and the warning still applies.
const partly = P.commandFeedback({
  command: 'Get-Something',
  shell: 'powershell',
  cwd: 'C:/Users/me',
  stdout: 'Name  Value',
  stderr: 'Access is denied',
  exitCode: 0,
  durationMs: 20,
  timedOut: false,
  truncated: false,
  readOnly: true
})
check(
  'a partial success is still flagged',
  partly.text.includes('REFUSED for want of permission'),
  true
)
// And an ordinary error is not mistaken for a permission problem.
check(
  'an ordinary failure is left alone',
  P.needsElevation({ stderr: 'Cannot find path C:/nope because it does not exist.' }),
  false
)

/**
 * The endings, asserted through the report the model is actually sent.
 *
 * These were string matches against App.tsx and broke when the report moved
 * into shared - which it had to, so bench-ceiling could grade the second
 * turn against the real thing rather than a copy. Asking the function what
 * it produces is the better test anyway: a string match would still pass if
 * the constant were imported and then used in the wrong branch.
 */
const result = (over) => ({
  command: 'Get-Command spotify',
  shell: 'powershell',
  cwd: 'C:/Users/me',
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 10,
  timedOut: false,
  truncated: false,
  readOnly: true,
  ...over
})

// A command PowerShell could not parse.
const parseError = P.commandFeedback(
  result({
    exitCode: 1,
    stderr: 'At line:1 char:1 + CategoryInfo : ParserError: (:) [], ParseException'
  })
)
check('the report uses the never-ran ending', parseError.text.includes(P.NEVER_RAN_ENDING[0]), true)
// The header said "I ran that command" over the top of "that command did NOT
// run", which is the app contradicting itself in the same message.
check(
  'and does not claim to have run it',
  parseError.text.includes('That command could not run.') &&
    !parseError.text.includes('I ran that command'),
  true
)

// A command that ran and returned non-zero.
const ranAndFailed = P.commandFeedback(
  result({ exitCode: 1, stderr: 'Start-Process : This command cannot be run' })
)
check('the failed ending is wired in', ranAndFailed.text.includes(P.FAILED_ENDING[0]), true)
check(
  'and only for a command that ran',
  ranAndFailed.text.includes('I ran that command') &&
    !ranAndFailed.text.includes(P.NEVER_RAN_ENDING[0]),
  true
)
// A timeout is neither of those and must not borrow either ending.
const stopped = P.commandFeedback(result({ exitCode: -1, timedOut: true, stdout: 'working...' }))
check(
  'a timeout gets neither ending',
  !stopped.text.includes(P.FAILED_ENDING[0]) && !stopped.text.includes(P.NEVER_RAN_ENDING[0]),
  true
)

// And an ordinary success still asks for an answer from the output.
const fine = P.commandFeedback(result({ stdout: 'C:/Program Files/nodejs/node.exe' }))
check(
  'the ordinary ending still says to answer from the output',
  fine.text.includes('Answer the original'),
  true
)

/* --------------------- a job that started and never said it ended -------- */

/**
 * Reported from real use, installing Claude Code: it did install, and it
 * was verified afterwards, but in between the reply said it was done when
 * it was not.
 *
 * Exit 0 means the command returned. An installer can hand off and keep
 * going after the shell comes back, and winget says so - it narrates every
 * phase, ending with "Successfully installed". Output that stops before
 * that line is a job still in progress.
 *
 * The ordinary ending was actively pushing the wrong answer here: "That
 * command is done. Do not propose it again. Answer the original question
 * from this output, in words" forbids the one command that would settle it.
 * A rule added to the prompt lost to it three runs out of three, because
 * the report is the last thing in the context.
 */
const install = (stdout, over = {}) =>
  P.commandFeedback({
    command: 'winget install --id Anthropic.ClaudeCode -e',
    shell: 'powershell',
    cwd: 'C:/Users/me',
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 184_000,
    timedOut: false,
    truncated: false,
    readOnly: false,
    ...over
  })

const STARTED = [
  'Found Claude Code [Anthropic.ClaudeCode] Version 2.1.4',
  'Downloading https://storage.example/claude-code-setup.exe',
  'Successfully verified installer hash',
  'Starting package install...'
].join(NL)

const unfinished = install(STARTED)
check('an install that only got as far as starting is caught', unfinished.kind, 'report')
check('it says the command returned, not that it worked', /RETURNED/.test(unfinished.text), true)
check(
  'it says what exit 0 actually means here',
  /exit code 0 here means the command ended/.test(unfinished.text),
  true
)
check('it forbids claiming the install', /Do NOT say it is installed/.test(unfinished.text), true)
// And does not leave it at "it is installing", which answers nobody.
check(
  'it forbids stopping there too',
  /Do NOT stop at "it is installing"/.test(unfinished.text),
  true
)
check('it asks for one more command', /Send ONE short, different command/.test(unfinished.text), true)
check(
  'and it replaces the ending that forbade exactly that',
  /Do not propose it again/.test(unfinished.text),
  false
)

/* An install that DID say it finished keeps the ordinary ending. */
const done = install(`${STARTED}${NL}Successfully installed`)
check('a completed install is not flagged', /RETURNED/.test(done.text), false)
check('and gets the ordinary ending', /Answer the original/.test(done.text), true)

/**
 * Narrow on purpose. A read that happens to mention the word "downloading"
 * is text, not a job in progress - and reads are most of what Wumpy runs.
 */
check(
  'a read that mentions downloading is left alone',
  /RETURNED/.test(install('Status: Downloading updates', { readOnly: true }).text),
  false
)
check(
  'a failed install keeps the failure ending',
  /RETURNED/.test(install(STARTED, { exitCode: 1 }).text),
  false
)
check(
  'and one that was cut off keeps the timeout ending',
  /RETURNED/.test(install(STARTED, { timedOut: true }).text),
  false
)
check('npm saying it added packages counts as finished', P.startedButUnfinished({
  stdout: 'npm warn deprecated inflight@1.0.6' + NL + 'added 1 package in 14s',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  readOnly: false
}), false)
check('and an uninstall that completed counts too', P.startedButUnfinished({
  stdout: 'Uninstalling...' + NL + 'Successfully uninstalled',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  readOnly: false
}), false)

console.log(failures ? `\n${failures} parse-failure checks FAILED` : '\nall parse-failure checks')
process.exitCode = failures ? 1 : 0

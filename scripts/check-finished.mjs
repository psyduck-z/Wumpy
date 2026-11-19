/**
 * "It still falsely claims that it's finished when it's not."
 *
 * Reported three times, most recently in those words. The shape is always a
 * wumpy-run block followed by a sentence saying the thing has happened - and
 * it cannot have, because the words after a block are written before the
 * block runs. On accept-all the command starts as the message lands, so the
 * claim is on screen while the installer is still going.
 *
 * The prompt has forbidden this at length for some time and the reports kept
 * coming. So this is the check that notices, and these are the cases it has
 * to get right - the false POSITIVES as much as the true ones, because this
 * line appears under a real answer and a wrong one is the app calling the
 * model a liar for reporting something true.
 *
 * Run with: npm run check:finished
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.finished-check.mjs')
await build({
  entryPoints: ['src/shared/finished.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const F = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

const NL = String.fromCharCode(10)
const F3 = String.fromCharCode(96).repeat(3)
const lines = (...parts) => parts.join(NL)
const RUN = (cmd) => lines(`${F3}wumpy-run`, cmd, F3)

/* ----------------------------------------------------- the reported failure */

const REPORTED = lines(
  'I will install Spotify for you.',
  '',
  RUN('winget install --id Spotify.Spotify -e'),
  '',
  'Spotify is now installed and ready to use.'
)
check('the reported shape is caught', F.claimsBeforeRunning(REPORTED), true)

/* The same claim in other words. The first version of the guard knew only
   the word "installed", and the claim simply moved. */
for (const [name, tail] of [
  ['ready to use', 'It is ready to use.'],
  ['all set', 'All set!'],
  ['you can now', 'You can now open it from the Start menu.'],
  ['good to go', "You're good to go."],
  ['successfully installed', 'Successfully installed.'],
  ["that's done", "That's done."]
]) {
  check(`and so is "${name}"`, F.claimsBeforeRunning(lines(RUN('winget install x'), '', tail)), true)
}

/* A plan of clicks makes the same claim about the same screen. */
check(
  'a wumpy-do block counts too',
  F.claimsBeforeRunning(lines(`${F3}wumpy-do`, 'press "Send"', F3, '', 'The email is now sent, all set.')),
  true
)

/* ------------------------------------------------- what must NOT be flagged */

/*
 * The expensive mistake. This line sits under a real answer, so a false
 * positive is the app contradicting something true.
 */
check(
  'a claim BEFORE the block is reporting, not predicting',
  F.claimsBeforeRunning(
    lines('Spotify is already installed, so I will just check the version.', '', RUN('spotify --version'))
  ),
  false
)
check(
  'an answer with no block at all is left alone',
  F.claimsBeforeRunning('Spotify is installed — I can see it in the list you pasted.'),
  false
)
/* The reason stripBlocks exists: the `# why` of the very command that proves
   the model did NOT believe the install. */
check(
  'the comment inside the block is not the claim',
  F.claimsBeforeRunning(
    lines(RUN('# check whether Spotify is installed' + NL + 'Get-StartApps'), '', 'This will tell us.')
  ),
  false
)
/* The reason HEDGED exists: a sentence that says it is looking. */
check(
  'a sentence that hedges is not an assertion',
  F.claimsBeforeRunning(lines(RUN('Get-StartApps'), '', 'This checks whether Spotify is installed.')),
  false
)
check(
  'nor is "let me verify it is installed"',
  F.claimsBeforeRunning(lines(RUN('spotify --version'), '', 'Let me confirm it is installed.')),
  false
)
/* Future tense is exactly what the prompt asks for, so it must pass. */
check(
  'the future tense the prompt asks for is fine',
  F.claimsBeforeRunning(lines(RUN('winget install x'), '', 'This will install it; I will tell you what the output says.')),
  false
)
check('empty text is not a claim', F.claimsBeforeRunning(''), false)

/* "it says it's done, but it's not, the command's not done": the claim
   came first, or in plainer words than "installed". */
const BASH = (cmd) => lines(`${F3}wumpy-run-bash`, cmd, F3)
check('"Done." over the command is caught', F.claimsBeforeRunning(lines('Done.', '', BASH('rm ~/Downloads/crossy-road.html'))), true)
check('and "Deleted crossy-road.html." over the rm', F.claimsBeforeRunning(lines('Deleted crossy-road.html.', BASH('rm ~/Downloads/crossy-road.html'))), true)
check('and "I\'ve removed it" after it', F.claimsBeforeRunning(lines(BASH('rm ~/a.txt'), '', "I've removed it.")), true)
check('and "It has been deleted"', F.claimsBeforeRunning(lines(BASH('rm ~/a.txt'), 'It has been deleted.')), true)
check('but "I will delete it" is the future, and fine', F.claimsBeforeRunning(lines('I will delete crossy-road.html.', BASH('rm ~/Downloads/crossy-road.html'))), false)
check('and a past fact about something else is fine', F.claimsBeforeRunning(lines('The old copy was deleted yesterday, so I will list what is left.', BASH('ls ~/Downloads'))), false)
check('and "deleted when you close it" is not a claim', F.claimsBeforeRunning(lines(BASH('ls /tmp'), '', 'Those are deleted when you restart.')), false)

/* --------------------------------------------------------------- the wiring */

const message = readFileSync('src/renderer/src/components/Message.tsx', 'utf8')
check('the transcript says so under the message', /claimsBeforeRunning\(shown\)/.test(message), true)
check('and only once the message is complete', /!animating && message\.role === 'assistant' && claimsBeforeRunning/.test(message), true)

/*
 * One implementation, not two. The grader lived in bench-ceiling alone, so
 * the bench could fail a model for a claim the app showed without comment.
 */
const bench = readFileSync('scripts/bench-ceiling.mjs', 'utf8')
check('the bench shares the app’s guard', /bundled\('src\/shared\/finished\.ts'/.test(bench), true)
check('and keeps no copy of the patterns', /const FINISHED_CLAIM =/.test(bench), false)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of`} finished-claim checks`)
process.exit(failures === 0 ? 0 : 1)

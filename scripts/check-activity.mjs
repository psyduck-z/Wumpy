/**
 * The live note that says what the model is doing.
 *
 * Asked for so a turn can be stopped before it finishes going wrong: "small
 * notes of what the ai is doing, like claude, like searching (whatever)...,
 * searching 2 patterns, so i can stop it when i sense its going the wrong
 * direction".
 *
 * Every case here is a PREFIX of a reply, because that is the only way this
 * is ever read: character by character as it arrives. A note that is only
 * correct once the block is closed is a note that arrives after the moment
 * it exists for, so the partial cases are the real tests and the complete
 * ones are the easy half.
 *
 * Run with: npm run check:activity
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.activity-check.mjs'
await build({
  entryPoints: ['src/shared/activity.ts'],
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
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const BT = String.fromCharCode(96).repeat(3)
const line = (...ls) => ls.join(NL)
const note = (text) => A.activityLine(A.activityFor(text))

/* ------------------------------------------------------------ nothing yet */

check('empty text says nothing', A.activityFor(''), null)
check('whitespace says nothing', A.activityFor(`  ${NL} `), null)
check('plain prose is a reply', note('Let me check that for you'), 'Writing a reply')

/* --------------------------------------------- the first line inside a fence */

/*
 * The case this was built for. The fence is open, the reason line has
 * arrived, and NOTHING else has - no query, no command, no closing fence.
 */
check(
  'a search is named from its reason line alone',
  note(line('Sure.', '', `${BT}wumpy-search`, '# What version of Electron ships Node 22')),
  'Searching · What version of Electron ships Node 22'
)
check(
  'before even the reason line',
  note(line('Sure.', '', `${BT}wumpy-search`)),
  'Searching'
)
check(
  'a command is named before the command is written',
  note(line(`${BT}wumpy-run`, '# Stop the Ollama process')),
  'Stopping · the Ollama process'
)
check(
  'and falls back to the command when there is no reason',
  note(line(`${BT}wumpy-run`, 'Get-Process | Where-Object MainWindowHandle -ne 0')),
  'Checking · Get-Process | Where-Object MainWindowHandle -ne 0'
)

/* ------------------------------------------------------------- every kind */

check('screen', note(line(`${BT}wumpy-screen`, '# See what the error says')), 'Looking at the screen · See what the error says')
check('ask', note(line(`${BT}wumpy-ask`, 'Which folder did you mean?', '- Downloads')), 'Asking · Which folder did you mean?')
check(
  'write leads on the filename, not the reason',
  note(line(`${BT}wumpy-write`, '# Save the script', 'path: C:\\Users\\zecha\\notes\\todo.md')),
  'Writing · todo.md'
)
check(
  'write before the path arrives uses the reason',
  note(line(`${BT}wumpy-write`, '# Save the script')),
  'Writing · Save the script'
)
check(
  'open leads on the destination',
  note(line(`${BT}wumpy-open`, '# Show the notes', 'https://www.electronjs.org/blog/v44')),
  'Opening · electronjs.org'
)
check(
  'open with a search line',
  note(line(`${BT}wumpy-open`, '# Look it up', 'search: electron 44 release notes')),
  'Opening · electron 44 release notes'
)

/* ----------------------------------------------- "searching 2 patterns" */

const twoSearches = line(
  `${BT}wumpy-search`,
  '# Electron 44 release date',
  'electron 44 release date',
  BT,
  'And the Node version:',
  `${BT}wumpy-search`,
  '# Which Node ships with it',
  'electron 44 node version'
)
check('a second block of the same kind counts', note(twoSearches), 'Searching · 2 · Which Node ships with it')
check('and the count is of that kind only', A.activityFor(twoSearches).count, 2)

const mixed = line(`${BT}wumpy-search`, '# a', 'a', BT, `${BT}wumpy-run`, '# b')
check('a different kind does not inherit the count', note(mixed), 'Running · b')

/* ------------------------------------------- the verb matches the command */

/*
 * "Running" is true of every run block and so says nothing. Asked for by
 * name: "add other ones too... for example, checking (e.g what model this pc
 * is)."
 */
const run = (...body) => note(line(`${BT}wumpy-run`, ...body))

check('a read is Checking', run('# Find out what model this PC is', 'Get-CimInstance Win32_ComputerSystem'), 'Checking · what model this PC is')
check('an install is Installing', run('# Get Spotify', 'winget install --id Spotify.Spotify -e'), 'Installing · Get Spotify')
check('an uninstall is Uninstalling', run('# Remove it again', 'winget uninstall Spotify.Spotify'), 'Uninstalling · Remove it again')
check('a kill is Stopping', run('# Stop the Ollama process', 'Stop-Process -Name ollama -Force'), 'Stopping · the Ollama process')
check('a delete is Deleting', run('# Tidy up', 'Remove-Item -Recurse C:/tmp/x'), 'Deleting · Tidy up')
check('a launch is Opening', run('# Open the notes app', 'Start-Process notepad'), 'Opening · the notes app')
check('a setting is Changing', run('# Turn the firewall back on', 'Set-NetFirewallProfile -Enabled True'), 'Changing · the firewall back on')
check('something unrecognised stays Running', run('# Do the thing', 'somebinary --flag'), 'Running · Do the thing')

/*
 * The order is the meaning: a pipeline that reads and then acts is named for
 * the acting, or every destructive one-liner reads as "Checking".
 */
check('read-then-kill is Stopping, not Checking', run('# Close it', 'Get-Process ollama | Stop-Process -Force'), 'Stopping · Close it')
check('read-then-launch is Opening', run('# Start it', 'Get-StartApps | Where-Object Name -like "*VNC*" | Start-Process'), 'Opening · Start it')

/* ------------------------------- the verb before the command has arrived */

/*
 * The reason is the EARLIER evidence and this whole feature is about being
 * early, so it names the verb until the command overrules it.
 */
check('the reason names the verb first', run('# Check the Node version'), 'Checking · the Node version')
check('and the command sharpens it', run('# Sort it out', 'winget install --id Git.Git -e'), 'Installing · Sort it out')
check('an unrecognised command leaves the reason standing', run('# Stop the server', 'pkill -f server'), 'Stopping · the server')

/* The repeated word is dropped, but only when the label came from it. */
check('a disagreeing reason keeps both halves', run('# Check whether it is running', 'Stop-Process -Name x'), 'Stopping · Check whether it is running')
check('a one-word reason is left alone', run('# Stop', 'Stop-Process -Name x'), 'Stopping · Stop')

/* --------------------------------------------------------- the long think */

check('reasoning with no answer yet is Thinking', A.activityLine(A.activityFor('', 'Let me work through this...')), 'Thinking')
check('and the answer takes over once it starts', A.activityLine(A.activityFor('Right, so', 'Let me work through this...')), 'Writing a reply')
check('neither still says nothing', A.activityFor('', ''), null)

/* ------------------------------------------------ fences that are not ours */

/*
 * A plain code block has a closing fence too. Treating it as ours ended the
 * wrong block, which showed up as the note reverting to "Writing a reply"
 * halfway through a command.
 */
const withCode = line(
  'Here is the shape:',
  `${BT}powershell`,
  'Get-Process',
  BT,
  'Now the real one:',
  `${BT}wumpy-run`,
  '# List the running processes'
)
check('a plain fence does not close our block', note(withCode), 'Checking · the running processes')
check(
  'and a plain fence alone is still just a reply',
  note(line('Example:', `${BT}powershell`, 'Get-Process')),
  'Writing a reply'
)

/* The normalised variants, which WUMPY_TAGS does not contain. */
check('run-cmd is recognised', note(line(`${BT}wumpy-run-cmd`, '# Show the IP')), 'Checking · the IP')
check('run-bash is recognised', note(line(`${BT}wumpy-run-bash`, '# List files')), 'Checking · files')

/* ------------------------------------------------------------- open state */

const stillOpen = line(`${BT}wumpy-run`, '# Stop it', 'Stop-Process -Name x')
const closed = line(stillOpen, BT)
check('an unclosed block reads as open', A.activityFor(stillOpen).open, true)
check('a closed one does not', A.activityFor(closed).open, false)
check(
  'and the note stays up after it closes',
  note(line(closed, '', 'That will stop it.')),
  'Stopping · Stop it'
)

/* ------------------------------------------------------------- shortening */

check('short detail is untouched', A.shorten('Stop the Ollama process'), 'Stop the Ollama process')
check('long detail is cut on a word', A.shorten('Find every process on this machine that currently owns a window'), 'Find every process on this machine that currently…')
check('a long unbroken token is cut hard', A.shorten('a'.repeat(80)).length, A.DETAIL_CHARS)
check('newlines in a detail are flattened', A.shorten(`two${NL}lines`), 'two lines')

/* ------------------------------------------- every prefix of a real reply */

/*
 * Streamed one character at a time, which is how it is actually read. The
 * requirement is not that every prefix says something useful - it is that
 * none of them throws, and that the note never goes BACKWARDS to "Writing a
 * reply" once a block has opened. A note that flickers is worse than none.
 */
const real = line(
  'I will look that up.',
  '',
  `${BT}wumpy-search`,
  '# What version of Node ships with Electron 44',
  'electron 44 node version',
  BT,
  '',
  'Then I will check what you have installed.',
  '',
  `${BT}wumpy-run`,
  '# Show the local Node version',
  'node --version',
  BT
)
let threw = 0
let reverted = 0
let sawBlock = false
for (let i = 1; i <= real.length; i++) {
  try {
    const a = A.activityFor(real.slice(0, i))
    if (a && a.kind !== 'reply' && a.kind !== 'think') sawBlock = true
    else if (sawBlock && a && a.kind === 'reply') reverted++
  } catch {
    threw++
  }
}
check(`no prefix of a ${real.length}-char reply throws`, threw, 0)
check('and the note never reverts to "writing a reply"', reverted, 0)

console.log(`${NL}${count - failed}/${count} activity checks passed`)
if (failed) process.exit(1)

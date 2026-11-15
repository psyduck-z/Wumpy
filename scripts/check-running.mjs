/**
 * What the card says while a command is still going.
 *
 * Two things are tested here. The words: every verb must be earned, either
 * by the command plainly being an install or by the output having just said
 * so - a rotating vocabulary that changes on a timer would pass no test
 * because it claims nothing. And the plumbing: output has to reach the card
 * while the process is alive, which is the whole point, and the last frame
 * has to arrive at all - the first version cancelled it on exit and a
 * one-second command streamed nothing.
 *
 * Run with: npm run check:running
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const ESC = String.fromCharCode(27)
const BACKSLASH = String.fromCharCode(92)

const out = '.running-check.mjs'
await build({
  entryPoints: ['src/shared/running.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { runningPhase, tailLines, stripAnsi } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const shellOut = '.running-shell.mjs'
await build({
  entryPoints: ['src/main/shell.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: shellOut,
  logLevel: 'error',
  external: ['electron'],
  alias: { '@shared': 'src/shared' }
})
const { runCommand } = await import(pathToFileURL(shellOut).href)
rmSync(shellOut, { force: true })

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
const verb = (cmd, output = '', s = 0) => runningPhase(cmd, output, s).verb
const note = (cmd, output = '', s = 0) => runningPhase(cmd, output, s).note

/* ------------------------------------------------- the verb from the command */

check('an install says so', verb('winget install --id ByteDance.CapCut -e'), 'installing')
check('and an uninstall is not an install', verb('winget uninstall --id Foo.Bar'), 'uninstalling')
check('a search is a search', verb('winget search "CapCut"'), 'searching')
check('npm counts as installing', verb('npm install --save-dev esbuild'), 'installing')
check('so does pip', verb('pip install requests'), 'installing')
check('a download is a download', verb('Invoke-WebRequest https://x/y -OutFile z'), 'downloading')
check('a ping waits on the network', verb('ping -n 5 1.1.1.1'), 'waiting on the network')
check(
  'a recursive listing is searching',
  verb(`Get-ChildItem C:${BACKSLASH}Users -Recurse`),
  'searching'
)
/* The whole-drive search by name, which is a minute of silence and the
   reason this file exists. The pattern wanted `dir /s` adjacent and this
   form puts the filename in between, so it used to read as "running". */
check(
  'and so is a whole-drive dir',
  verb(`cmd /c "dir C:${BACKSLASH}PD.cap /s /b"`),
  'searching'
)
check('a delete says delete', verb(`Remove-Item C:${BACKSLASH}tmp.txt`), 'deleting')
check('a copy says copy', verb('Copy-Item a b'), 'copying')
check('a version probe is checking', verb('node --version'), 'checking')
check('a Get- is checking', verb('Get-StartApps | Where-Object Name -like "*Spotify*"'), 'checking')
check('and anything else is just running', verb('$x = 1 + 1; $x'), 'running')

/* --------------------------------------------------- the verb from the output */

/**
 * winget narrates its own phases, and what it says beats what the command
 * looked like. This is the only reason the word is allowed to change at all.
 */
const WINGET = [
  'Found CapCut [ByteDance.CapCut] Version 9.4.0.4015',
  'Downloading https://example.invalid/capcut.exe',
  '  120 MB / 120 MB',
  'Successfully verified installer hash',
  'Starting package install...'
]
const upTo = (n) => WINGET.slice(0, n).join(NL)

check('output beats the command', verb('winget install --id X', upTo(5)), 'installing')
check('and the latest line wins, not the first', verb('winget install --id X', upTo(3)), 'downloading')
check('a verify step is named', verb('winget install --id X', upTo(4)), 'verifying')
check('extracting is unpacking', verb('x', 'Extracting archive 4 of 9'), 'unpacking')

/**
 * Nothing in here invents a phase. Output that says nothing recognisable
 * leaves the verb exactly where the command put it.
 */
check(
  'unrecognised output changes nothing',
  verb('winget install --id X', 'Microsoft Windows [Version 10.0.26300]'),
  'installing'
)

/* ----------------------------------------------------------------- the clock */

check('nothing is said early on', note('winget install x', '', 5), null)
check('and nothing at nineteen seconds', note('winget install x', '', 19), null)
check(
  'at twenty an installer explains itself',
  note('winget install x', '', 25),
  'installers can take a few minutes'
)
check('but a quick command just says still going', note('node --version', '', 25), 'still going')
check(
  'a silent minute is reported as silent',
  note('winget install x', '', 70),
  'over a minute, nothing printed yet'
)
check('a talkative one is not', note('winget install x', 'Downloading...', 70), 'over a minute in')
check('three minutes is unusual', note('winget install x', 'x', 200), 'this is unusually long')

/* The ceiling is ten minutes, and the card says so before it arrives. */
check(
  'and the ceiling is named before it hits',
  note('winget install x', 'x', 545),
  'it will be stopped at ten minutes'
)

/* ------------------------------------------------------------- what is shown */

check('blank lines are dropped', tailLines(`a${NL}${NL}${NL}b`, 6), ['a', 'b'])
check('only the last few survive', tailLines('1 2 3 4 5 6 7 8'.split(' ').join(NL), 3), [
  '6',
  '7',
  '8'
])

/**
 * A progress bar redraws with a carriage return rather than a newline. Split
 * on newlines alone and it is one line growing sideways forever; here each
 * redraw starts a line, which is what a terminal does with it, and asking
 * for one line gives the newest frame.
 */
check('a redraw starts a new line', tailLines(`Downloading${NL}10%${CR}40%${CR}90%`, 6), [
  'Downloading',
  '10%',
  '40%',
  '90%'
])
check('and the last frame is the newest', tailLines(`10%${CR}40%${CR}90%`, 1), ['90%'])

/* Colour codes arrive even with NO_COLOR set, and must not be shown raw. */
check('colour codes are stripped', stripAnsi(`${ESC}[32mdone${ESC}[0m`), 'done')
check('and do not count as a line', tailLines(`${ESC}[2K${CR}ok`, 6), ['ok'])

/* ------------------------------------------- it actually arrives while running */

/**
 * The reason this exists: a three-minute install used to show one unchanging
 * word. If the output only turns up at the end, nothing above matters.
 */
const WINDOWS = process.platform === 'win32'
/* The same programs in each platform's shell: PowerShell on Windows, bash
   elsewhere (which is what Wumpy runs commands in there). */
const SAY = (word) => (WINDOWS ? `Write-Output "${word}"` : `echo "${word}"`)
const seen = []
const t0 = Date.now()
const body = ['Write-Output "line $i"', 'Start-Sleep -Milliseconds 400'].join('; ')
const script = WINDOWS
  ? `foreach ($i in 1..4) { ${body} }`
  : 'for i in 1 2 3 4; do echo "line $i"; sleep 0.4; done'
const slow = await runCommand(script, 'powershell', process.cwd(), (text) =>
  seen.push({ at: Date.now() - t0, text })
)
check('output arrives in several frames, not one', seen.length >= 3, true)
check('the first lands well before the command ends', seen[0]?.at < slow.durationMs - 500, true)
check('and it is the real output', tailLines(seen.at(-1).text, 1), ['line 4'])

/**
 * A command shorter than the flush interval writes everything it has to say
 * and exits. The first version cleared the pending timer on close, so that
 * whole class streamed nothing at all - measured as flushes: 0 against
 * output that was plainly in the result.
 */
const quick = []
await runCommand(SAY('once'), 'powershell', process.cwd(), (t) => quick.push(t))
check('a command faster than one frame still sends it', quick.length, 1)
check('with everything it printed', tailLines(quick[0] ?? '', 1), ['once'])

/** Asking for no progress must not change the result. */
const silent = await runCommand(SAY('plain'), 'powershell', process.cwd())
check('and progress is optional', silent.stdout.trim(), 'plain')

console.log(`${NL}${count - failed}/${count} running-state checks correct`)
process.exit(failed === 0 ? 0 : 1)

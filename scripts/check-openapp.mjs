/**
 * Runs the open-an-app command exactly as the prompt renders it.
 *
 * Three times now the app-opening command has failed in the user's hands, and
 * every time the prompt said something I had not actually executed:
 *
 *   1. It led with Get-AppxPackage, which cannot see a desktop install.
 *   2. The replacement carried a line break after -ErrorAction, which ends
 *      the statement in PowerShell. I had verified a one-line version and
 *      written a two-line one into the prompt.
 *   3. It said to launch with Start-Process "Spotify", which fails because
 *      the app is not on PATH.
 *
 * Reading the prompt catches none of those. So this pulls the command out of
 * OPEN_PROMPT itself - not a copy, the real string - and runs it. Launching
 * is neutered by rewriting Start-Process, so the check never actually opens
 * anything; everything up to that point is real.
 *
 * Needs Windows and powershell.exe, and is written against this machine:
 * Spotify is installed as a desktop app, Calculator is a Store app, and the
 * third name exists nowhere. Those three cover both AppID shapes and the
 * absent case.
 *
 * Run with: node scripts/check-openapp.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'

const out = join(process.cwd(), '.openapp-check.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const T = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(50)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* ------------------------------------- the command, straight from the prompt */

const lines = T.OPEN_PROMPT.split(String.fromCharCode(10)).filter((l) =>
  l.includes('Get-StartApps |')
)
check('two commands: one to ask, one to act', lines.length, 2)

const ASK = (lines.find((l) => !l.includes('Start-Process')) ?? '').trim()
const ACT = (lines.find((l) => l.includes('Start-Process')) ?? '').trim()

/**
 * The separation is the whole point of this pair.
 *
 * They were merged into one command that checked and launched together, to
 * save a round trip on "open Spotify". The consequence was that asking "is
 * Spotify installed" - a question - opened Spotify. The user had not asked
 * for that, was in the middle of something, and got a login window over the
 * top of it. Then the model said "I did not open Spotify. I checked whether
 * it is installed", while the output of its own command read LAUNCHED.
 *
 * A command that answers a question must not be able to start anything. That
 * is asserted here rather than left to the prose above it.
 */
check('the asking one exists', ASK.length > 0, true)
check(
  'and cannot start anything',
  /Start-Process|Invoke-Item|explorer|cmd \/c|&\s/.test(ASK),
  false
)
check('it only reads', /^Get-StartApps \| Where-Object [^;]*\| Select-Object/.test(ASK), true)
check('with no statement separator to hide a second command', ASK.includes(';'), false)
check('the acting one exists', ACT.length > 0, true)
check('and is the one that launches', ACT.includes('Start-Process'), true)

check(
  'both are one line',
  ASK.includes(String.fromCharCode(10)) || ACT.includes(String.fromCharCode(10)),
  false
)
const TEMPLATE = ACT

if (!TEMPLATE) {
  console.log('\nno command found in OPEN_PROMPT — nothing to run')
  process.exitCode = 1
} else if (process.platform !== 'win32') {
  console.log('\nnot Windows — the command itself was not run')
} else {
  function runRaw(cmd) {
    return new Promise((resolve) => {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { windowsHide: true }
      )
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      p.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })
  }

  async function processCount(name) {
    const res = await runRaw(
      `(Get-Process ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`
    )
    return Number(res.stdout.trim()) || 0
  }

  function run(name) {
    // Start-Process becomes Write-Output, so resolution is real and the
    // launch is not. A check that opened Spotify on every run would be its
    // own kind of bug.
    const cmd = TEMPLATE.split('*name*')
      .join(`*${name}*`)
      .split('Start-Process ')
      .join('Write-Output RESOLVED ')
    return new Promise((resolve) => {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { windowsHide: true }
      )
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      p.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })
  }

  /**
   * The asking command, run for real with nothing neutered.
   *
   * Spotify is deliberately not running when this starts, and must still not
   * be running after. This is the check that would have caught the merged
   * command: it looked like a question and started an app.
   */
  const before = await processCount('Spotify')
  const asked = await runRaw(ASK.split('*name*').join('*Spotify*'))
  const after = await processCount('Spotify')
  check('asking runs cleanly', asked.code, 0)
  check('and answers the question', asked.stdout.includes('Spotify'), true)
  check('and started nothing', after <= before, true)
  check('with nothing on stderr', asked.stderr, '')

  const spotify = await run('Spotify')
  check('a desktop app: the command parses and runs', spotify.code, 0)
  check('with nothing on stderr', spotify.stderr, '')
  check('it reports LAUNCHED', spotify.stdout.includes('LAUNCHED'), true)
  // A desktop install's AppID is the path to the exe, used directly. Checked
  // across the whole output rather than on the RESOLVED line: Write-Output
  // with two arguments emits two objects, so they land on separate lines.
  check('resolving to a real executable', /[A-Z]:\\[^\n]*\.exe/i.test(spotify.stdout), true)
  check('and not through shell:AppsFolder', spotify.stdout.includes('AppsFolder'), false)

  const store = await run('Calculator')
  check('a Store app also runs', store.code, 0)
  check('and reports LAUNCHED', store.stdout.includes('LAUNCHED'), true)
  // A Store AppID contains "!" and only works via shell:AppsFolder. This is
  // the branch that a single Start-Process $a would have got wrong.
  check('resolving through shell:AppsFolder', store.stdout.includes('AppsFolder'), true)
  check('with the package id', store.stdout.includes('!App'), true)

  const absent = await run('ThisAppIsNotInstalledAnywhere')
  check('an absent app runs cleanly', absent.code, 0)
  check('and says NOT INSTALLED', absent.stdout, 'NOT INSTALLED')
  // The whole point: absent must be a clean answer, not an error the model
  // then has to interpret.
  check('without an error to misread', absent.stderr, '')
  check('and never claims to have launched', absent.stdout.includes('LAUNCHED'), false)
}

console.log(failures ? `\n${failures} open-app checks FAILED` : '\nall open-app checks')
process.exitCode = failures ? 1 : 0

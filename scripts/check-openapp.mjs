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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
/**
 * Three now: ask, act, and the one that splits a name into its parts.
 *
 * The third was added because "open tiger.vnc" was answered with
 * Get-StartApps on the whole string, which matched nothing, and the model
 * called that not installed.
 */
check('three Get-StartApps commands: ask, act, split', lines.length, 3)

const ACT = (lines.find((l) => l.includes('Start-Process')) ?? '').trim()
/* NOT just '-match': the launching command tests $a -match '!' for an AppID. */
const SPLIT = (
  lines.find((l) => l.includes('-match') && !l.includes('Start-Process')) ?? ''
).trim()
const ASK = (
  lines.find((l) => !l.includes('Start-Process') && !l.includes('-match')) ?? ''
).trim()

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
  /**
   * Pick the apps to test from the machine, not from a list I wrote.
   *
   * This suite used to hard-code Spotify as the desktop install and
   * Calculator as the Store app. Then the user uninstalled Spotify while
   * testing the uninstall path, and five checks failed for a reason that had
   * nothing to do with the code. A check that breaks when the machine
   * changes is describing an inventory, not a behaviour.
   *
   * So: ask Get-StartApps for one app of each AppID shape. A "!" in the id
   * means a Store package that has to go through shell:AppsFolder; anything
   * else is a path launched directly. Those two shapes are what the command
   * branches on, so one of each is exactly the coverage needed.
   */
  async function pickApp(storeApp) {
    const op = storeApp ? '-match' : '-notmatch'
    const res = await runRaw(
      `Get-StartApps | Where-Object AppID ${op} '!' | Select-Object -First 1 -ExpandProperty Name`
    )
    return res.stdout.trim()
  }

  const desktopApp = await pickApp(false)
  const storeApp = await pickApp(true)
  check('found a desktop-style app to test with', Boolean(desktopApp), true)
  check('and a Store one', Boolean(storeApp), true)

  /**
   * The asking command, run for real with nothing neutered.
   *
   * It must answer, and it must start nothing. This is the check that would
   * have caught the merged check-and-launch command: it looked like a
   * question and opened an app.
   */
  const probe = desktopApp.split(' ')[0]
  const before = await processCount('explorer')
  const asked = await runRaw(ASK.split('*name*').join(`*${probe}*`))
  const after = await processCount('explorer')
  check('asking runs cleanly', asked.code, 0)
  check('and answers the question', asked.stdout.trim().length > 0, true)
  check('and started nothing', after <= before, true)
  check('with nothing on stderr', asked.stderr, '')

  const spotify = await run(probe)
  check('a desktop app: the command parses and runs', spotify.code, 0)
  check('with nothing on stderr', spotify.stderr, '')
  check('it reports LAUNCHED', spotify.stdout.includes('LAUNCHED'), true)
  check('and not through shell:AppsFolder', spotify.stdout.includes('AppsFolder'), false)

  const store = await run(storeApp.split(' ')[0])
  check('a Store app also runs', store.code, 0)
  check('and reports LAUNCHED', store.stdout.includes('LAUNCHED'), true)
  // A Store AppID contains "!" and only works via shell:AppsFolder. This is
  // the branch a single Start-Process $a would have got wrong.
  check('resolving through shell:AppsFolder', store.stdout.includes('AppsFolder'), true)

  /**
   * The uninstall lookup, run verbatim from the prompt.
   *
   * Asked to uninstall Spotify, Wumpy searched HKLM and HKLM\WOW6432Node,
   * got nothing, and said "Spotify is not installed" - while it was. Spotify
   * was a per-user install with no HKLM entry at all. The name is taken from
   * the registry here for the same reason the apps are taken from
   * Get-StartApps: so this tests the query, not the machine.
   */
  /**
   * The command-line check, which did not exist and should have.
   *
   * Asked "do I have claude", then "do I have claude in my terminal", Wumpy
   * answered "Claude is not installed" both times - from Get-StartApps,
   * which only sees Start-menu entries. Measured on this machine:
   *
   *   Get-StartApps  *Claude*   nothing
   *   Get-Command    claude     C:\Users\zecha\.local\bin\claude.exe
   *
   * It was running inside Claude at the time. The second answer was not even
   * re-checked; the qualifier "in my terminal" is a different question and
   * got the previous answer back.
   */
  const cliLine = T.OPEN_PROMPT.split(String.fromCharCode(10)).find((l) =>
    l.includes('Get-Command <name>')
  )
  check('the prompt has a command-line check', Boolean(cliLine), true)
  const CLI = (cliLine ?? '').trim()
  check('on one line', CLI.includes(String.fromCharCode(10)), false)
  check('it only reads', /Start-Process|Remove-|Set-/.test(CLI), false)

  // Run it against tools that are and are not on PATH here.
  for (const tool of ['winget', 'node']) {
    const r = await runRaw(CLI.split('<name>').join(tool))
    check(`it finds ${tool}`, r.stdout.trim().length > 0, true)
    check(`and gives ${tool} a path`, /^[A-Za-z]:/m.test(r.stdout.trim()), true)
  }
  const missing = await runRaw(CLI.split('<name>').join('definitelyNotAToolXYZ'))
  check('and nothing for a tool that is absent', missing.stdout.trim(), '')
  // Absent must be a clean empty result, not an error the model then has to
  // interpret - that distinction is what -ErrorAction SilentlyContinue buys.
  check('without an error to misread', missing.stderr, '')

  const uninstLine = T.OPEN_PROMPT.split(String.fromCharCode(10)).find((l) =>
    l.includes('UninstallString')
  )
  check('the prompt gives an uninstall lookup', Boolean(uninstLine), true)
  const UNINST = (uninstLine ?? '').trim()
  check('on one line', UNINST.includes(String.fromCharCode(10)), false)
  check('it searches HKCU', UNINST.includes('HKCU:'), true)
  check('and both HKLM hives', (UNINST.match(/HKLM:/g) ?? []).length, 2)
  check('tolerating keys it cannot read', UNINST.includes('-ErrorAction SilentlyContinue'), true)
  // It must only look. Chaining the lookup to the removal would turn a
  // question about uninstalling into an uninstall.
  check('and cannot uninstall anything', /msiexec|Start-Process|&\s/.test(UNINST), false)

  const anyInstalled = await runRaw(
    'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.UninstallString } | Select-Object -First 1 -ExpandProperty DisplayName'
  )
  const known = anyInstalled.stdout.trim().split(' ')[0]
  check('found something installed to look up', Boolean(known), true)
  const found = await runRaw(UNINST.split('*name*').join(`*${known}*`))
  check('the lookup finds it', found.stdout.includes(known), true)
  check('with an uninstall string', /Uninstall|msiexec/i.test(found.stdout), true)
  const neither = await runRaw(UNINST.split('*name*').join('*ThisIsNotInstalledXYZ*'))
  check('and nothing for an app that is absent', neither.stdout, '')

  const absent = await run('ThisAppIsNotInstalledAnywhere')
  check('an absent app runs cleanly', absent.code, 0)
  check('and says NOT INSTALLED', absent.stdout, 'NOT INSTALLED')
  // The whole point: absent must be a clean answer, not an error the model
  // then has to interpret.
  check('without an error to misread', absent.stderr, '')
  check('and never claims to have launched', absent.stdout.includes('LAUNCHED'), false)
}

/* --------------------------- the loose .exe nobody installed ------------- */

/**
 * The case that started this: "open tiger.vnc".
 *
 * Get-StartApps found nothing, so the model said not installed. It was a
 * portable vncviewer64-1.16.2.exe sitting in Downloads - no Start-menu entry,
 * no registry entry, not on PATH - which Windows Search shows and
 * Get-StartApps cannot. Two separate mistakes in one answer, searching the
 * whole phrase and treating one empty source as proof, so both are pinned.
 *
 * The fallback command is pulled out of the prompt and RUN, against a
 * temporary folder substituted for the real roots. Reading it would not have
 * caught any of the three times a command in this prompt shipped broken.
 */
check('the name is split on its parts, not matched whole', /-match '[a-z]+[|][a-z]+'/.test(SPLIT), true)
check('and the split search only reads', /Start-Process|Remove-|Stop-/.test(SPLIT), false)

const DISK = (
  T.OPEN_PROMPT.split(String.fromCharCode(10))
    .map((l) => l.trim())
    .find((l) => l.startsWith('$r = @(') && l.includes('Get-ChildItem')) ?? ''
)
check('there is an on-disk fallback at all', DISK.length > 0, true)
check('which only reads', /Remove-|Start-Process|Stop-|Set-/.test(DISK), false)
check('and is one line', DISK.includes(String.fromCharCode(10)), false)

if (DISK && process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-app-'))
  mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
  /* Named like an executable; the command matches on the name, not content. */
  writeFileSync(join(dir, 'nested', 'deeper', 'tigervnc-9.9.9.exe'), 'x')
  writeFileSync(join(dir, 'nested', 'unrelated.exe'), 'x')

  /* Swap the real roots for the temp folder, leaving the rest verbatim. */
  const quoted = String.fromCharCode(34) + dir.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92)) + String.fromCharCode(34)
  const runnable = DISK.replace(/^[$]r = @\([^)]*\)[^;]*;/, `$r = @(${quoted});`)
  check('the roots were substituted', runnable !== DISK, true)

  /* Its own runner: runRaw lives inside the Windows branch above. */
  const got = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', runnable],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', () => resolve({ stdout: stdout.trim(), stderr: stderr.trim() }))
  })
  check('it finds a loose exe nobody installed', got.stdout.includes('tigervnc-9.9.9.exe'), true)
  check('without an error', got.stderr, '')
  check('and ignores one that does not match', got.stdout.includes('unrelated.exe'), false)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} open-app checks FAILED` : '\nall open-app checks')
process.exitCode = failures ? 1 : 0

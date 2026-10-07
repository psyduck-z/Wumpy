/**
 * Runs the keyboard helper's own self-test, and checks the panel cannot be
 * toggled faster than a person can press a key.
 *
 * The helper's rules live in C#, so the scenarios that matter - press and hold,
 * Win released before C, a release the hook never saw - are driven through the
 * shipped decision inside the exe, by `--selftest`. This script's job is to make
 * sure that test is actually run, and run against the current source: a stale
 * binary would pass while saying nothing about the code in the tree.
 *
 * Holding Win+C used to report a toggle per auto-repeat - about thirty a second,
 * 41 of them in the hold scenario - which looked like the panel flashing rather
 * than like a hotkey.
 *
 * Run with: npm run check:hotkey
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
}

/* ------------------------------------------------ the helper's own scenarios */

const exe = 'resources/hook/WumpyHook.exe'
const source = 'src/hook/Program.cs'

if (process.platform !== 'win32') {
  console.log('--  not Windows; the keyboard helper cannot run here')
} else if (!existsSync(exe)) {
  console.log(`--  ${exe} is not built; run npm run hook:build`)
} else {
  // A binary older than the source proves nothing about the source.
  const fresh = statSync(exe).mtimeMs >= statSync(source).mtimeMs
  check(fresh, fresh ? 'the built helper is current' : `${source} is newer than ${exe}; run npm run hook:build`)

  if (fresh) {
    let out = ''
    let ok = true
    try {
      out = execFileSync(exe, ['--selftest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      ok = false
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    check(ok && /keys=ok/.test(out), `helper key scenarios: ${out.trim().split('\n').pop() ?? 'no output'}`)
    check(/sendinput=ok/.test(out), 'SendInput still accepts the INPUT layout')
  }
}

/* ------------------------------------- one press cannot mean several toggles */

const src = readFileSync(source, 'utf8')
check(/WM_KEYUP/.test(src) && /WM_SYSKEYUP/.test(src), 'the hook watches releases, not only presses')
check(
  (src.match(/Console\.WriteLine\("TOGGLE"\)/g) ?? []).length === 1,
  'TOGGLE is reported from exactly one place'
)

/**
 * RegisterHotKey repeats while held too, and any extra accelerator in the
 * settings goes through it, so the panel needs its own guard as well.
 */
const panel = readFileSync('src/main/panel.ts', 'utf8')
const toggle = panel.slice(panel.indexOf('toggle(): void'), panel.indexOf('setPinned'))
check(/lastToggle/.test(toggle), 'toggle() ignores a repeat arriving on its heels')

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} hotkey checks`)
process.exit(failed === 0 ? 0 : 1)

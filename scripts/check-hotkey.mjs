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
  check(
    fresh,
    fresh ? 'the built helper is current' : `${source} is newer than ${exe}; run npm run hook:build`
  )

  if (fresh) {
    let out = ''
    let ok = true
    try {
      out = execFileSync(exe, ['--selftest'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      ok = false
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    check(
      ok && /keys=ok/.test(out),
      `helper key scenarios: ${out.trim().split('\n').pop() ?? 'no output'}`
    )
    check(/sendinput=ok/.test(out), 'SendInput still accepts the INPUT layout')
  }
}

/* ------------------------------------- one press cannot mean several toggles */

const src = readFileSync(source, 'utf8')
check(
  /WM_KEYUP/.test(src) && /WM_SYSKEYUP/.test(src),
  'the hook watches releases, not only presses'
)
check(
  (src.match(/Console\.WriteLine\([^;]*"TOGGLE/g) ?? []).length === 1,
  'TOGGLE is reported from exactly one place'
)

/* --------------------------------------- the two ends of the hook protocol */

/**
 * Both sides of a line protocol, pinned together.
 *
 * The toggle line gained a suffix - `TOGGLE granted` / `TOGGLE ungranted` -
 * so that the one thing nobody had ever checked, whether the foreground
 * grant actually succeeds, shows up in the log. An exact-match reader on the
 * other side would have turned that into a hotkey that silently stopped
 * working, which is a far worse bug than the one being fixed.
 */
const driver = readFileSync('src/main/lowlevelhook.ts', 'utf8')
check(
  /message\.startsWith\('TOGGLE /.test(driver),
  'main accepts a TOGGLE line that carries a suffix'
)
check(/ACTIVATE \$\{/.test(driver), 'main can ask the helper to activate a window')
check(/StartsWith\("ACTIVATE /.test(src), 'the helper listens for ACTIVATE on stdin')
check(/startsWith\('ACTIVATE'\)/.test(driver), "and main logs the helper's answer")

/**
 * The activation has to happen after the window is visible: you cannot give
 * the foreground to a window that is not on screen.
 */
const shown = readFileSync('src/main/panel.ts', 'utf8')
/* Located by a regex rather than a literal signature: show() grew a reason
   parameter and this quietly started slicing from the wrong end. */
const showAt = shown.search(/^  show\(/m)
check(showAt > -1, 'show() is where this check thinks it is')
const show = shown.slice(showAt, shown.indexOf('watchKeyboard'))
check(
  show.indexOf('win.show()') < show.indexOf('this.activator?.('),
  'the panel is shown before the helper is asked to activate it'
)
check(
  /readBigUInt64LE/.test(shown),
  'the window handle is read as 64 bits, not truncated to 32'
)

/** The imports that only fail at call time, which here is the worst moment. */
check(/SwitchToThisWindow/.test(src), 'the helper has a lever the foreground rules do not govern')
check(/ForegroundSelfTest/.test(src), 'and the self-test proves those imports resolve')

/**
 * RegisterHotKey repeats while held too, and any extra accelerator in the
 * settings goes through it, so the panel needs its own guard as well.
 */
const panel = readFileSync('src/main/panel.ts', 'utf8')
const toggle = panel.slice(panel.indexOf('toggle(): void'), panel.indexOf('setPinned'))
check(/lastToggle/.test(toggle), 'toggle() ignores a repeat arriving on its heels')

/**
 * Losing the helper for the session is not a small thing.
 *
 * When the restart budget is spent it falls back to globalShortcut, which
 * cannot grant the foreground - the one job the helper exists to do. So the
 * budget must not be spendable by accident, and it was: three exits at any
 * three moments of a run, reset only by a READY that arrived. The log has
 * two thirds of it going to a machine falling asleep, 0x40010004 and
 * 0xC0000142 one second apart at 05:29, with the transcriber dying between
 * them. Failures now expire, so the budget means three CLOSE TOGETHER.
 */
check(/lastExitAt/.test(driver), 'an old helper failure stops counting against the budget')
check(/this\.restarts = 0\s*$/m.test(driver.replace(/\r/g, '')), 'the counter is actually reset')
check(/falling back to globalShortcut/.test(driver), 'and giving up is said out loud')

/**
 * The log is the first thing consulted before theorising, so it must not cry
 * wolf. Every renderer level above info went to console.error, which made
 * `gave up waiting for the keyboard` - a warning, and benign when
 * caretHere=true - read as `ERROR [renderer]` and look like the autofocus
 * bug returning. The positional arguments were deprecated too, and said so
 * in the log once per message.
 */
check(/details\.level === 'error' \? console\.error : console\.warn/.test(panel), 'a renderer warning is logged as a warning')
check(/on\('console-message', \(details\) =>/.test(panel), 'through the signature that is not deprecated')
check(/details\.sourceId/.test(panel), 'and the source still names the file')

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} hotkey checks`)
process.exit(failed === 0 ? 0 : 1)

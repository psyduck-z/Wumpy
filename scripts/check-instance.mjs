/**
 * One Wumpy, and only one window when you open it twice.
 *
 * Reported as: "it opens for like a brief second and it closes and it opens
 * again, like a little flash". Measured, with the window's own show/hide
 * events written to the log:
 *
 *   [14:18:24.357] [wumpy] started                              second copy
 *   [14:18:24.365] [panel] show   (a second Wumpy was started)   first copy
 *   [14:18:24.369] another Wumpy already has the lock; quitting  second copy
 *   [14:18:24.743] [panel] show   (launch)                       second copy
 *   [14:18:24.789] [panel] focus  (launch)                       second copy
 *
 * The cause is that `app.quit()` does not stop the file it is called in. It
 * asks the event loop to wind down and returns, so a process that has just
 * been told it is surplus goes on to register its ready handler, build a
 * window, show it and take the keyboard - and then dies, leaving the first
 * copy's window behind it. Open, shut, open.
 *
 * It is an easy mistake to make twice, and nothing about the code looks
 * wrong, so this pins the shape of the fix rather than trusting a comment:
 * the lock's answer is kept, the bootup is guarded on it, and the surplus
 * process exits rather than asking.
 *
 * Run with: npm run check:instance
 */
import { readFileSync } from 'node:fs'

const main = readFileSync('src/main/index.ts', 'utf8')
const tray = readFileSync('src/main/tray.ts', 'utf8')

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

/* ------------------------------------------------- the lock and the guard */

const lockLine = main.match(/^.*requestSingleInstanceLock\(\).*$/m)?.[0] ?? ''
check('the lock is called exactly once', main.split('requestSingleInstanceLock()').length - 1, 1)
check('its answer is kept, not discarded', /^const \w+ = app\.requestSingleInstanceLock/.test(lockLine.trim()), true)

const flag = lockLine.match(/const (\w+) =/)?.[1] ?? ''
check('the flag has a name', flag.length > 0, true)

const guard = new RegExp(`if \\(!${flag}\\)\\s*return`)
check('the bootup returns early when the lock was refused', guard.test(main), true)

/*
 * And before anything is built. A guard that runs after panel.create() would
 * pass the test above and still put a second window on the screen.
 */
const guardAt = main.search(guard)
const createAt = main.indexOf('panel.create()')
const showAt = main.indexOf('panel.show(')
check('it is reached before the window is created', guardAt > -1 && guardAt < createAt, true)
check('it is reached before the window is shown', guardAt > -1 && guardAt < showAt, true)

/*
 * exit(), not quit(). quit() leaves the surplus process alive for about a
 * second - measured at +942ms - which is long enough for Windows to hand it
 * the foreground and take the keyboard off the panel that was just summoned.
 */
const surplus = main.slice(main.indexOf(`if (!${flag})`), guardAt > -1 ? guardAt : main.length)
check('the surplus process exits', /app\.exit\(/.test(surplus), true)
check('it does not merely ask to quit', /app\.quit\(/.test(surplus), false)

/* ------------------------------------------------------- the handover back */

check('a second launch raises the first copy', /app\.on\('second-instance',/.test(main), true)

/* ---------------------------------------------------- every show says why */

/*
 * The whole diagnosis above came out of knowing which caller started each
 * show, so an unlabelled one is a hole in the next bug report. Six callers:
 * the hotkey, the tray icon, the tray menu, launch, a second instance and
 * the renderer's close button.
 */
const unlabelled = [...main.matchAll(/panel\??\.(show|hide)\(\)/g)].map((m) => m[0])
check('no show() or hide() in index.ts without a reason', unlabelled, [])
const trayUnlabelled = [...tray.matchAll(/panel\.(show|hide)\(\)/g)].map((m) => m[0])
check('no show() or hide() in tray.ts without a reason', trayUnlabelled, [])

/*
 * toggle() is the exception: it picks between show and hide itself and
 * labels both sides, so it takes no argument from its callers.
 */
check('the hotkey goes through toggle()', /panel\.toggle\(\)/.test(main), true)

/* ------------------------------------------------------------ the trace */

const panel = readFileSync('src/main/panel.ts', 'utf8')
for (const event of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore']) {
  check(`'${event}' is traced`, panel.includes(`win.on('${event}', note('${event}'))`), true)
}

console.log(`\n${count - failed}/${count} checks passed`)
if (failed) process.exit(1)

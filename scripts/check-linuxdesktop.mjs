/**
 * Clicking and typing on Linux: what the prompt promises, and what the helper
 * answers.
 *
 * Wumpy on Linux once told the user it could look at the screen and could not
 * move the mouse, because its prompt said so - which was true then. Now there
 * is a helper (src/linux), so:
 *
 *   - with the helper, the Linux prompt carries the same wumpy-do section as
 *     Windows and nothing in it says there is no mouse control;
 *   - without it, it still says so, because then that is the truth;
 *   - the helper answers every verb with one line beginning with that verb,
 *     including the ones it must refuse, without touching the screen.
 *
 * Run with: node scripts/check-linuxdesktop.mjs
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `   ${detail}`}`)
}

const out = '.linuxdesktop-check.mjs'
await build({ entryPoints: ['src/shared/assistant.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const A = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const shape = (over) => ({ scope: 'full', search: true, screen: true, browser: true, quota: false, platform: 'linux', ...over })
const withHands = A.assemblePrompt(shape({ hands: true }))
const without = A.assemblePrompt(shape({ hands: false }))
const windows = A.assemblePrompt(shape({ platform: 'win32' }))

check('Linux with the helper is told it can click', /YOU CAN CLICK AND TYPE ON THEIR SCREEN/.test(withHands))
check('and gets the wumpy-do block', /```wumpy-do/.test(withHands))
check('and the Linux note', /ON THIS MACHINE \(Linux, Hyprland\)/.test(withHands))
check('and is never told there is no mouse control as a fact', !/There is no mouse control here/.test(withHands))
check('Linux without the helper is not promised a click', !/YOU CAN CLICK AND TYPE/.test(without))
check('and is told there is no mouse control then', /there is no mouse control on this machine/.test(without))
check('Windows is unchanged: it can click', /YOU CAN CLICK AND TYPE/.test(windows) && !/ON THIS MACHINE \(Linux/.test(windows))
check('no screen, no clicking, on Linux either', !/YOU CAN CLICK/.test(A.assemblePrompt(shape({ hands: true, screen: false }))))
const stub = A.assemblePrompt(shape({ hands: true, needs: [] }))
check('a turn not about the desktop gets the one-line stub', /You can click and type on their screen with a ```wumpy-do/.test(stub))

/* The helper, by itself: verbs it must answer without a display. */
const replies = (() => {
  try {
    return execFileSync('python3', ['src/linux/desktop.py', '--owner=1'], {
      input: ['CLICK x y', 'SCROLL 1', 'TYPE @@@', 'KEY ', 'KEY ctrl+nosuchkey', 'PRESS !!', 'NOPE', ''].join('\n') + '\n',
      encoding: 'utf8',
      timeout: 20000,
      /* No compositor: nothing it does can reach the real screen. */
      env: { PATH: process.env.PATH, HOME: process.env.HOME, WAYLAND_DISPLAY: 'wumpy-check-none', HYPRLAND_INSTANCE_SIGNATURE: 'none' }
    })
      .trim()
      .split('\n')
  } catch (err) {
    return [`ERROR ${err.message}`]
  }
})()
check('the helper says it is ready', /^READY linux/.test(replies[0] ?? ''), replies[0])
const want = [
  ['CLICK FAILED bad-coordinates', 'a click with no numbers'],
  ['SCROLL FAILED bad-arguments', 'a scroll with too few numbers'],
  ['TYPE FAILED not-base64', 'typing that is not base64'],
  ['KEY FAILED empty', 'an empty key'],
  ['KEY FAILED', 'a key it does not know'],
  ['PRESS FAILED not-base64', 'a name that is not base64'],
  ['NOPE FAILED unknown-command', 'an unknown verb']
]
want.forEach(([prefix, what], i) => {
  const got = replies[i + 1] ?? ''
  check(`one reply for ${what}, starting with its verb`, got.startsWith(prefix), got)
})
check('and nothing more', replies.length === want.length + 1, `${replies.length} lines`)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nLinux clicking: promised only when the helper is there, and the helper always answers')

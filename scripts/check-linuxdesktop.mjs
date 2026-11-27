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
import { readFileSync, rmSync } from 'node:fs'
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
    return execFileSync('python3', ['src/linux/desktop.py', '--owner=1', '--no-a11y'], {
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

/* The pointer: Wumpy leaves it where it clicked (focus follows the mouse on
   Hyprland, so putting it back would hand the keyboard to whatever is under
   it), and GUARD must still report where the USER had it - or the next step
   would stop with "the mouse moved" - until somebody really moves it. */
const pointer = (() => {
  try {
    return execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, sys',
          "spec = importlib.util.spec_from_file_location('d', 'src/linux/desktop.py')",
          'd = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)',
          'pos = [(100, 100)]',
          'd.cursor = lambda: pos[0]',
          "d.hypr = lambda *a: None",
          'def guard():',
          '    d.guard()',
          'lines = []',
          'd.out = lambda l: lines.append(l)',
          'd.guard()',
          'pos[0] = (900, 400); d.placed((100, 100)); d.guard()',
          'pos[0] = (950, 420); d.placed((900, 400)); d.guard()',
          'pos[0] = (300, 300); d.guard(); d.guard()',
          "d.key('backspace', 401); d.key('backspace', 0)",
          "print('\\n'.join(lines))"
        ].join('\n')
      ],
      { encoding: 'utf8', timeout: 20000 }
    )
      .trim()
      .split('\n')
  } catch (err) {
    return [`ERROR ${err.message}`]
  }
})()
const at = (line) => /cursor=(-?\d+,-?\d+)/.exec(line ?? '')?.[1]
check('GUARD reports the pointer where it is, to begin with', at(pointer[0]) === '100,100', pointer[0])
check('after Wumpy moves it, GUARD still says where they had it', at(pointer[1]) === '100,100', pointer[1])
check('and after a second move of Wumpy\'s, still theirs', at(pointer[2]) === '100,100', pointer[2])
check('once they move it themselves, the real place - so the plan stops', at(pointer[3]) === '300,300', pointer[3])
check('and it stays the real place after that', at(pointer[4]) === '300,300', pointer[4])
check('a key repeated more than Windows allows is refused, not cut short', /^KEY FAILED repeat-out-of-range=401/.test(pointer[5] ?? ''), pointer[5])
check('and so is a repeat of none', /^KEY FAILED repeat-out-of-range=0/.test(pointer[6] ?? ''), pointer[6])

/* The source, for the two things that broke on Hyprland 0.56's Lua dispatch. */
const src = readFileSync('src/linux/desktop.py', 'utf8')
check('focusing a window uses the Lua dispatch, with the old form as fallback', /hl\.dsp\.focus\(\{+ window = /.test(src) && /'focuswindow'/.test(src))
check('and nothing calls the old forms on their own', !/run\(\['hyprctl', 'dispatch', '(focuswindow|movecursor)'/.test(src))
check('a click no longer puts the pointer back (it would move the focus)', !/pointer=\{'restored'/.test(src))
/* Keys go through wumpy-pointer's own keyboard, whole keymap and all: with
   fcitx5 running, wtype's BackSpace, Delete and ctrl+a never arrive. */
const keyFn = src.slice(src.indexOf('def key('), src.indexOf('# ----', src.indexOf('def key(')))
check('keys go to the helper keyboard first, wtype only as a fallback', keyFn.indexOf("[POINTER, 'key'") > 0 && keyFn.indexOf("[POINTER, 'key'") < keyFn.indexOf("['wtype']"))
const csrc = readFileSync('src/linux/wumpy-pointer.c', 'utf8')
check('and that keyboard uploads a real keymap, not a made-up one', /xkb_keymap_new_from_names/.test(csrc) && /zwp_virtual_keyboard_v1_keymap/.test(csrc))

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nLinux clicking: promised only when the helper is there, and the helper always answers')

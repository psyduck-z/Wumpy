/**
 * Getting around without the mouse.
 *
 * Wumpy opens on a keystroke, so reaching for the mouse to finish what you
 * started with Win+C defeats most of the point. The arithmetic of moving a
 * selection is checked here; the wiring - which card registers, which handler
 * is bound - is read off the source, because the thing being checked is that
 * a path exists at all.
 *
 * Run with: node scripts/check-keyboard.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, existsSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.kb-check.mjs')
await build({
  entryPoints: ['src/renderer/src/keyboard.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const K = await import(pathToFileURL(out).href)

const focusOut = join(process.cwd(), '.kb-focus.mjs')
await build({
  entryPoints: ['src/renderer/src/focus.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: focusOut,
  logLevel: 'error'
})
const F = await import(pathToFileURL(focusOut).href)

const cmdOut = join(process.cwd(), '.kb-cmds.mjs')
await build({
  entryPoints: ['src/renderer/src/commands.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: cmdOut,
  logLevel: 'error'
})

// Both bundles are read by now; leaving them in the repo root is litter.
rmSync(out, { force: true })
rmSync(focusOut, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

/* ------------------------------------------------------- moving a selection */

check('Right goes forward', K.nextIndex('ArrowRight', 0, 3), 1)
check('Down does the same', K.nextIndex('ArrowDown', 0, 3), 1)
check('Left goes back', K.nextIndex('ArrowLeft', 2, 3), 1)
check('Up does the same', K.nextIndex('ArrowUp', 2, 3), 1)

// A row of two or three buttons is a loop in the user's head, and stopping
// dead at the edge reads as the key not working.
check('forward from the end wraps', K.nextIndex('ArrowRight', 2, 3), 0)
check('back from the start wraps', K.nextIndex('ArrowLeft', 0, 3), 2)

// Nothing focused yet: forward should land on the first, back on the last.
check('forward with nothing focused takes the first', K.nextIndex('ArrowRight', -1, 3), 0)
check('back with nothing focused takes the last', K.nextIndex('ArrowLeft', -1, 3), 2)

check('Home is the first', K.nextIndex('Home', 2, 3), 0)
check('End is the last', K.nextIndex('End', 0, 3), 2)

check('a letter is not ours', K.nextIndex('a', 0, 3), -1)
check('nor is Enter', K.nextIndex('Enter', 0, 3), -1)
check('nor Tab, which the browser already does', K.nextIndex('Tab', 0, 3), -1)
check('an empty group moves nowhere', K.nextIndex('ArrowRight', -1, 0), -1)
check('a group of one still answers', K.nextIndex('ArrowRight', 0, 1), 0)
check('and wrapping it is itself', K.nextIndex('ArrowLeft', 0, 1), 0)

/* ------------------------------------------- not stealing keys from typing */

// Arrows inside a text box move the caret. Taking them for navigation would
// make the composer unusable, which is a worse outcome than no navigation.
check('a textarea is typing', K.isTypingTarget({ tagName: 'TEXTAREA' }), true)
check('so is an input', K.isTypingTarget({ tagName: 'INPUT' }), true)
check('and a contenteditable', K.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
check('a button is not', K.isTypingTarget({ tagName: 'BUTTON' }), false)
check('nor a plain div', K.isTypingTarget({ tagName: 'DIV' }), false)
check('case does not matter', K.isTypingTarget({ tagName: 'textarea' }), true)
check('null is not', K.isTypingTarget(null), false)
check('nor undefined', K.isTypingTarget(undefined), false)
check('nor an object with no tag', K.isTypingTarget({}), false)
// Duck-typed on purpose: an element from another realm is a real HTMLElement
// that fails instanceof, and failing here means stealing a keystroke from
// something the user is typing into.
check(
  'a foreign-realm element still counts',
  K.isTypingTarget(Object.assign(Object.create(null), { tagName: 'INPUT' })),
  true
)

/* ------------------------------------------------- the wiring, as it exists */

const read = (f) => readFileSync(f, 'utf8')
const app = read('src/renderer/src/App.tsx')
const pending = read('src/renderer/src/pending.ts')
const styles = read('src/renderer/src/styles.css')

// Every proposal must be approvable from the keyboard, not just commands.
// Before this the shortcut was a half-truth: hands stayed put for a command
// and went to the mouse for a file or a link.
for (const card of ['CommandCard', 'WriteCard', 'LinkCard']) {
  const src = read(`src/renderer/src/components/${card}.tsx`)
  check(`${card} can be approved by keyboard`, src.includes('registerPending('), true)
  check(`${card} arrows between its buttons`, src.includes('arrowNavigate('), true)
}
// The tier bar was the other radiogroup and it is gone with the tiers. The
// model picker is what replaced it, reached with Ctrl+M where Ctrl+1..4 and
// Ctrl+D used to jump between tiers and modes.
check('the tier bar is gone', existsSync('src/renderer/src/components/TierBar.tsx'), false)
check(
  'Ctrl+M opens the model picker instead',
  /'m'[\s\S]{0,80}setPicker\('model'\)/.test(app),
  true
)
check(
  'and the picker already did',
  read('src/renderer/src/components/Picker.tsx').includes("'ArrowDown'"),
  true
)

check(
  'Ctrl+Enter approves the newest',
  /newestPending\(\)[\s\S]{0,120}pending\.run\(\)/.test(app),
  true
)
check(
  'Ctrl+Shift+Enter skips it',
  /newestPending\(\)[\s\S]{0,120}pending\.skip\(\)/.test(app),
  true
)
check('Ctrl+Down steps into a proposal', /ArrowDown[\s\S]{0,200}\.cmd, \.ask/.test(app), true)
check(
  'Escape steps back out to the composer',
  /insideCard[\s\S]{0,160}composer textarea/.test(app),
  true
)
check(
  'and only then, so it still closes the panel',
  /if \(insideCard\) \{[\s\S]{0,200}\n\s*\}\n\s*e\.preventDefault\(\)/.test(app),
  true
)
check('the registry is newest-first by intent', pending.includes('most recently registered'), true)

// Arrow keys are useless if you cannot see where you are, so the ring is
// part of the feature rather than a polish pass.
check('focus is visible everywhere', styles.includes(':focus-visible'), true)
check(
  'using focus-visible, not focus',
  /:where\(button[\s\S]{0,140}:focus-visible/.test(styles),
  true
)
check('a focused card is distinguishable', /\.cmd:focus-within/.test(styles), true)
check(
  'destructive buttons ring in their own colour',
  /\.cmd-run\.is-risky:focus-visible/.test(styles),
  true
)

/* ------------------------- an automatic mode should not keep asking */

// Accept-all means accept all. A card that still draws Skip and Run in that
// mode makes the setting a lie - and the search card did exactly that in every
// mode, while being the only proposal that touches nothing on this machine.
for (const card of ['CommandCard', 'WriteCard', 'LinkCard', 'SearchCard']) {
  const src = read(`src/renderer/src/components/${card}.tsx`)
  check(`${card} hides its buttons behind waiting`, src.includes('{waiting && ('), true)
  check(
    `${card} leaves the automatic case out of waiting`,
    /const waiting =[\s\S]{0,140}!(unattended|autoWrite|itself)/.test(src),
    true
  )
}

const searchSrc = read('src/renderer/src/components/SearchCard.tsx')
check(
  'a search runs itself in both automatic modes',
  searchSrc.includes("mode === 'all' || mode === 'auto'"),
  true
)
check('and says so rather than going quiet', searchSrc.includes('searching automatically'), true)
check('it cannot fire twice for one commit', /searched\.current/.test(searchSrc), true)

/**
 * Risky commands are the deliberate exception in the ASKING modes, where
 * the verdict refuses auto for them and those buttons come back on purpose.
 *
 * Narrowed twice and then abandoned. First it stopped for anything risky,
 * then only for the severe ones - deleting files, disabling Defender,
 * writing into Startup - and the user's answer to the second narrowing was
 * the same as to the first: "I SAID ALLOW EVERYTHING". Accept-all now stops
 * for nothing at all, so the severity split survives only for manual and
 * auto. See check-acceptall.mjs, which owns that rule; this file only has
 * to agree with it.
 */
const mainSrc = read('src/main/index.ts')
/* The rule itself is decide() in shell.ts, which judge() calls and
   check-approval.mjs runs. */
const shellSrc = read('src/main/shell.ts')
check(
  'severity decides, not merely riskiness',
  /const level = riskLevel\(command, shell\)/.test(mainSrc) && /decide\(\{ readOnly, level/.test(mainSrc),
  true
)
check(
  'accept-all stops for nothing',
  /v\.mode !== 'all' && v\.level !== 'none'/.test(shellSrc),
  true
)
check(
  'and the dialog follows the same verdict',
  /const silent =[\s\S]{0,160}verdict\.auto/.test(mainSrc),
  true
)
check('and auto requires not-risky', shellSrc.includes('const auto = allowed && !risky'), true)
// A link to something on this machine is what an injected link would aim at.
check(
  'a local link still asks, even on accept-all',
  read('src/shared/links.ts').includes('if (check.local) return false'),
  true
)

/* ------------------------------ the caret is in the box when it opens */

// Wumpy opens on a keystroke, so arriving at a window you have to click
// before you can type undoes most of the point of the hotkey.
const composer = read('src/renderer/src/components/Composer.tsx')

check('showing the panel focuses the box', /\[focusToken(, tucked)?\]/.test(composer), true)
// The hotkey arrives in a background hook, so Windows hands the foreground
// over asynchronously and a focus() made before that lands is dropped. The
// retrying now lives in focus.ts, and is checked above by its rules rather
// than by the shape of a call here.
check('and keeps trying until it sticks', composer.includes('insistFocus('), true)
// The composer sits at the bottom; focusing it the ordinary way yanks a long
// transcript down to the end, which is not what reopening should do to what
// you were reading.
const focusSrc = read('src/renderer/src/focus.ts')
check('without dragging the transcript to the end', focusSrc.includes('preventScroll: true'), true)

check(
  'coming back to the window focuses it too',
  app.includes("window.addEventListener('focus'"),
  true
)
check('but never over something already focused', app.includes('active !== document.body'), true)
check('nor over an open picker', app.includes("querySelector('.picker')"), true)
check(
  'and the composer will not steal from one either',
  composer.includes("querySelector('.picker')"),
  true
)
check(
  'the listener is cleaned up',
  app.includes("removeEventListener('focus', onWindowFocus)"),
  true
)
check(
  '.picker is a class that exists',
  read('src/renderer/src/components/Picker.tsx').includes('className="picker"'),
  true
)

/* --------------------------------------------- being there when you log in */

/**
 * Lives in the keyboard suite because this file is about reaching Wumpy at
 * all, and the hotkey is no use if nothing is running to receive it.
 *
 * Start-at-login did nothing whatsoever when run from source. The guard was
 * `if (!app.isPackaged) return`, written for a real reason - registering the
 * bare Electron binary would start an empty Electron on login - and it
 * reached the wrong conclusion. The tray menu still drew a checkbox, the
 * setting still saved as on, and the Run key was never touched. The user
 * turned it on, shut down, booted, and found no tray icon.
 *
 * Verified by running the registered command itself, not just reading it:
 * four Electron processes, no panel, tray only.
 */
const startup = read('src/main/index.ts')
check(
  'start-at-login is not skipped in dev',
  /function syncLaunchAtLogin[\s\S]{0,200}if \(!app\.isPackaged\) return/.test(startup),
  false
)
check('it registers an explicit path', /path: process\.execPath/.test(startup), true)
// From source, Electron needs the app directory or it opens nothing.
check(
  'with the app directory when unpackaged',
  /app\.isPackaged \? \['--hidden'\] : \[app\.getAppPath\(\), '--hidden'\]/.test(startup),
  true
)
// Logging in should leave it in the tray, not throw a panel over a desktop
// that is still settling.
check('and starts hidden', /'--hidden'/.test(startup), true)
check('which the startup path honours', /process\.argv\.includes\('--hidden'\)/.test(startup), true)
// Applied on boot as well as on change, or the setting saved before this fix
// would stay unregistered forever.
check(
  're-applied at startup',
  /syncLaunchAtLogin\(settings\.get\('launchAtLogin'\)\)/.test(startup),
  true
)

/* ----------------------------------------- no two things on one chord */

/**
 * Ctrl+M was bound twice, and one of them never ran.
 *
 * Dictation had it first, on a window listener in the CAPTURE phase. I added
 * the model picker to the same chord without checking, so pressing it started
 * recording and the picker never opened - a shortcut that was documented in
 * /help and in the Ctrl+K list while doing nothing at all.
 *
 * Collisions are invisible from either side: each handler looks correct on
 * its own. So the chords are collected from where they are declared and
 * compared.
 */
// The two authoritative lists: the per-command shortcuts and the key-only
// rows. Scraping /help as well double-counts every chord, since the table
// restates them.
const cmds = await import(pathToFileURL(cmdOut).href)
rmSync(cmdOut, { force: true })
const declared = [
  ...Object.values(cmds.SHORTCUT_FOR).filter(Boolean),
  ...cmds.KEY_ONLY.map((k) => k.keys)
]
const norm = (c) => c.replace(/\s/g, '').toLowerCase()
/**
 * Esc is the one chord that is deliberately layered: it stops a running
 * answer, else steps out of a card, else hides the panel. Each layer only
 * fires when the one before it does not apply, which is the opposite of the
 * Ctrl+M problem - there, two handlers both wanted the same key at the same
 * time and the loser was invisible.
 */
const LAYERED = new Set(['esc'])
const seen = declared.map(norm).filter((c) => !LAYERED.has(c))
check(
  'no chord is listed for two things',
  [...new Set(seen.filter((c, i) => seen.indexOf(c) !== i))],
  []
)

// The specific pair that broke, asserted by name so it cannot come back.
check('dictation keeps Ctrl+M', composer.includes("e.key.toLowerCase() === 'm'"), true)
check(
  'the model picker is on Ctrl+Shift+M',
  /e\.ctrlKey && e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === 'm'/.test(app),
  true
)
// Plain Ctrl+M must fall through to dictation rather than being handled here.
check('and plain Ctrl+M is left alone', /=== 'm'\) return/.test(app), true)
check('the help table agrees', cmds.SHORTCUT_FOR.model, 'Ctrl+Shift+M')

/* ------------------------------ the caret actually landing in the box */

/**
 * This has been "fixed" twice and stayed broken, which is why it is now
 * tested rather than reasoned about.
 *
 * Wumpy opens on a global hotkey, so the foreground belongs to whatever the
 * user was in and Windows hands it over asynchronously. A focus() made before
 * the window holds it is silently dropped and the keystroke goes to the
 * editor underneath. The previous fix retried once on the next animation
 * frame - about 16ms, against a handover that routinely takes 50-250ms - so
 * the retry landed in the same gap as the first attempt.
 *
 * The rule is now: keep trying until document.hasFocus() is true AND the
 * caret is here, with a deadline so it cannot fight the user for the
 * keyboard afterwards.
 */
const attempt = (o) => ({ hasFocus: true, isActive: true, elapsedMs: 0, yielded: false, ...o })

check(
  'keep trying while the window has no focus yet',
  F.shouldKeepTrying(attempt({ hasFocus: false, isActive: true })),
  true
)
check(
  'and while the caret is somewhere else',
  F.shouldKeepTrying(attempt({ isActive: false })),
  true
)
// The success condition is BOTH, which is the thing the old fix got wrong:
// focusing an element in a window that does not hold the keyboard changes
// which element WOULD receive keys, not where the keys are going.
check(
  'stop once both are true',
  F.shouldKeepTrying(attempt({ hasFocus: true, isActive: true })),
  false
)
check(
  'focused element alone is not enough',
  F.shouldKeepTrying(attempt({ hasFocus: false, isActive: true })),
  true
)

// Long enough to outlast a slow foreground handover. 16ms was not.
check('the deadline outlasts a real handover', F.FOCUS_DEADLINE_MS >= 250, true)
check('and is not so long it fights the user', F.FOCUS_DEADLINE_MS <= 1500, true)
check('retries are frequent enough to catch it', F.FOCUS_RETRY_MS <= 50, true)
check(
  'give up at the deadline',
  F.shouldKeepTrying(attempt({ hasFocus: false, isActive: false, elapsedMs: F.FOCUS_DEADLINE_MS })),
  false
)
check(
  'and just before it, keep going',
  F.shouldKeepTrying(
    attempt({ hasFocus: false, isActive: false, elapsedMs: F.FOCUS_DEADLINE_MS - 1 })
  ),
  true
)

// A picker focuses its own filter. Stealing that back would be worse than
// never having had focus at all.
check(
  'yield to something that wants the keyboard',
  F.shouldKeepTrying(attempt({ hasFocus: false, isActive: false, yielded: true })),
  false
)
check(
  'even when everything else says keep going',
  F.shouldKeepTrying(attempt({ hasFocus: true, isActive: false, yielded: true })),
  false
)

/**
 * The retry must survive a hidden window, which is the only window it ever
 * runs in.
 *
 * Chromium throttles hidden windows: requestAnimationFrame stops. The loop
 * was driven from a frame callback, so it died after its first attempt - and
 * the first attempt is precisely the one that happens before Windows has
 * handed the foreground over, which is the one that never works. It looked
 * like a retry loop and behaved like a single try.
 */
// A call, not the comment explaining why there is no call.
check('the loop is not driven by rAF', /requestAnimationFrame\(/.test(focusSrc), false)
check('it uses a timer instead', /timer = setTimeout\(attempt/.test(focusSrc), true)
check('and says why', focusSrc.includes('Chromium stops rAF for a'), true)
const panel = read('src/main/panel.ts')
check(
  'the window is not throttled when hidden',
  panel.includes('backgroundThrottling: false'),
  true
)

/**
 * The half of autofocus that was never in the renderer.
 *
 * Three attempts at this were spent in the composer, because from inside the
 * page a half-working focus looks like success. Measured over the DevTools
 * protocol with the panel open:
 *
 *   document.activeElement  the composer textarea   (right)
 *   document.hasFocus()     false                   (wrong)
 *
 * The caret was in the box; the keystrokes were going to whatever was
 * underneath. Two separate causes, both in the main process.
 *
 * type: 'toolbar' is WS_EX_TOOLWINDOW, which keeps a window out of Alt+Tab
 * and also makes it one Windows will not activate. Dropping it fixed the
 * launch case and not the real one.
 *
 * The real one is the foreground lock: Windows will not hand the foreground
 * to a process that is not already there, which Wumpy never is, because the
 * hotkey arrives in a background hook. show(), focus() and
 * app.focus({ steal: true }) all return happily and none of them wins it.
 * Restoring a minimized window is a path Windows does grant, so that is the
 * fallback - measured with another app made foreground first, hasFocus()
 * went false -> true.
 */
const panelSrc = read('src/main/panel.ts')
// The property, not the comment above it explaining its absence. The same
// shape of false positive as the rAF check further down.
check(
  'the panel is not a tool window',
  panelSrc.split(String.fromCharCode(10)).some((l) => /^\s*type: 'toolbar'/.test(l)),
  false
)
check('and says why not', panelSrc.includes('WS_EX_TOOLWINDOW'), true)
// On Windows. On Linux it is an ordinary app window (REGULAR_WINDOW) and
// belongs wherever the compositor lists windows.
check(
  'it still stays off the taskbar',
  /skipTaskbar: (true|!REGULAR_WINDOW)\b/.test(panelSrc) &&
    panelSrc.includes("REGULAR_WINDOW = process.platform === 'linux'"),
  true
)
// The ordinary route first, so the usual case pays nothing.
check('app.focus is still tried first', /app\.focus\(\{ steal: true \}\)/.test(panelSrc), true)
// Immediately, inside show(). Measured: the same calls made ~600ms later
// through an IPC round trip do not work, because whatever right to change
// the foreground the process has, it has it then and not after.
check(
  'with a restore fallback when it fails',
  /const polite = win\.isFocused\(\)[\s\S]{0,200}if \(!polite\)[\s\S]{0,900}win\.minimize\(\)[\s\S]{0,120}win\.restore\(\)/.test(
    panelSrc
  ),
  true
)
// Unconditional minimize/restore would flicker on every single open.
check(
  'and only when it failed',
  /win\.minimize\(\)/.test(panelSrc) && /if \(!polite\)/.test(panelSrc),
  true
)

/**
 * And the one thing about that fallback nobody had ever checked.
 *
 * The window is created with minimizable: false. The whole fallback rests on
 * minimize/restore being a route Windows grants activation to - so if
 * Electron declines the minimize, it has been doing nothing at all on every
 * path that reached it. A measurement, not an assumption, is the only way
 * that question gets settled.
 */
check('and says whether the minimize did anything', /isMinimized\(\)/.test(panelSrc), true)

/**
 * Every open says whether the keyboard actually arrived.
 *
 * Five fixes for this bug were shipped and not one of them could be
 * confirmed, because the only thing that knows is document.hasFocus() in the
 * page, and the one line that reported it went to a console that
 * `npm run restart` throws away. A fix nobody can check is a fix nobody
 * should believe.
 */
check('the panel measures its own focus', /watchKeyboard/.test(panelSrc), true)
check('from the page, not from isFocused()', /document\.hasFocus\(\)/.test(panelSrc), true)
check('and writes it where it can be read', /from '\.\/log'/.test(panelSrc), true)

/**
 * The grant, which is what makes focus work without a trick.
 *
 * Windows refuses SetForegroundWindow from a process that did not receive
 * the last input, and Wumpy never does: the keystroke arrives in the hook,
 * and Wumpy only hears about it on stdout afterwards. Everything tried in
 * the main process was working around that rather than fixing it.
 *
 * Measured over real Win+C presses, with the minimize/restore fallback as
 * the only mechanism: 2 of 3. Not a race I could see from the renderer, and
 * not something a retry loop can fix.
 *
 * The hook DID receive the input, so it may hand the right on with
 * AllowSetForegroundWindow before it reports the toggle. One call, no
 * flicker, nothing to retry.
 */
const hookSrc = read('src/hook/Program.cs')
check('the hook grants foreground rights', hookSrc.includes('AllowSetForegroundWindow'), true)
check('to a pid it was told', hookSrc.includes('--grant-foreground='), true)
check(
  'before the toggle, not after',
  /AllowSetForegroundWindow\(_grantPid\)[\s\S]{0,400}WriteLine\(granted/.test(hookSrc),
  true
)
check('and only when it has one', hookSrc.includes('_grantPid != 0'), true)

/**
 * The grant is reported now, rather than assumed.
 *
 * Its return value was discarded, and the comment above it - and the comment
 * in panel.ts, and two of the assertions here - all described a mechanism
 * that nobody had ever seen succeed. `TOGGLE granted` / `TOGGLE ungranted`
 * is the difference between a theory and a reading.
 */
check('the grant result is not discarded', /var granted = /.test(hookSrc), true)

/**
 * The start-menu breaker goes FIRST.
 *
 * It injects a keystroke, and the foreground rules are keyed on input: doing
 * it after the grant meant the last thing Windows saw, before Wumpy asked
 * for the keyboard, was a keystroke that belonged to whatever was
 * underneath. Nothing is lost by moving it, since the Win key is still held
 * either way.
 */
check(
  'the start-menu breaker runs before the grant',
  hookSrc.indexOf('SuppressStartMenu();') < hookSrc.indexOf('AllowSetForegroundWindow(_grantPid)'),
  true
)

/**
 * And the part that no longer depends on a grant at all.
 *
 * A one-shot token handed to another process has to be spent before the
 * moment passes, and the moment is a pipe write, a Node wake-up and an
 * Electron show away. The helper received the keystroke, so the helper does
 * the activating - on the window Wumpy names, once it is on screen.
 */
check('the helper can activate a window itself', /private static void Activate/.test(hookSrc), true)
check('on its own thread, so a wedge cannot take the hook down', /Name = "activate"/.test(hookSrc), true)
check('joining the foreground thread input queue', /AttachThreadInput/.test(hookSrc), true)
check('with a lever the foreground rules do not govern', /SwitchToThisWindow/.test(hookSrc), true)
check(
  'Wumpy passes its own pid',
  read('src/main/lowlevelhook.ts').includes('--grant-foreground=${process.pid}'),
  true
)

/**
 * setOpacity is NOT used to hide the activation flicker.
 *
 * It was the obvious way to stop the panel visibly vanishing and coming
 * back, and measured over real hotkey presses it took focus from 2-of-3 to
 * 0-of-3: making the window layered stops Windows activating it at all. A
 * negative result worth keeping, because the idea is an appealing one.
 */
// A call, not the comment recording why there is no call.
check(
  'opacity is not used around activation',
  panelSrc.split(String.fromCharCode(10)).some((l) => /^\s*win\.setOpacity\(/.test(l)),
  false
)

/**
 * And a last resort driven by the page, because only the page knows.
 *
 * document.hasFocus() is the truth and the main process cannot read it;
 * win.isFocused() is a proxy that can say true while Windows has handed
 * nothing over. So when the renderer runs out of patience without the
 * keyboard, it says so and the main process tries once more.
 *
 * It works far less often than show()'s own attempt - measured, the delay is
 * what costs it - so it is a salvage path, not the mechanism.
 */
check('the renderer can report losing the keyboard', panelSrc.includes('forceFocus()'), true)
check(
  'on its own channel',
  read('src/shared/types.ts').includes("panelRefocus: 'panel:refocus'"),
  true
)
check('exposed to the page', read('src/preload/index.ts').includes('requestFocus:'), true)
check(
  'and only when it gave up without focus',
  focusSrc.includes('!state.hasFocus && !state.yielded'),
  true
)
check('the composer asks for it', composer.includes('panel.requestFocus()'), true)

check('the composer uses it', composer.includes('insistFocus('), true)
check(
  'and yields to an open picker',
  /insistFocus\([\s\S]{0,160}querySelector\('\.picker'\)/.test(composer),
  true
)
// The old one-frame retry must not come back alongside it.
check(
  'the single-frame retry is gone',
  /requestAnimationFrame\([\s\S]{0,120}focus\(\{ preventScroll/.test(composer),
  false
)

/* ------------------- a reopened chat must not do it all again */

// Reported as "every time I reopen a chat it reruns the scripts". The command
// card had been told since it was written that an automatic mode applies only
// to this session - the comment on that guard literally says "without this an
// automatic mode would run the whole transcript again on load" - and the
// other three had not. So reopening a saved chat on accept-all re-opened
// every link in it, rewrote every file and re-ran every search.
check('the session guard exists', app.includes('const fresh = generated.current.has(m.id)'), true)
check('commands use it', app.includes('canAutoRun={fresh ? claimAutoRun : undefined}'), true)
check('writing uses it', app.includes('autoWrite={fresh &&'), true)
check('links and searches use it', app.includes("linkMode={fresh ? linkMode : 'manual'}"), true)
// Demoted to asking rather than disabled: a deliberate click on a reopened
// card should still work.
check('a reopened card keeps its buttons', app.includes("fresh ? linkMode : 'manual'"), true)

/* ------------------------ a keystroke that landed nowhere is not lost */

/**
 * The fifth attempt at the autofocus bug, and the first that does not rest
 * on a theory of why the caret is missing.
 *
 * The four before it each fixed a plausible cause - the foreground handover,
 * the animation frame a hidden window never runs, the foreground grant in
 * the hook, the proxy that reported focus the window did not have - and the
 * report came back each time. So this one treats the symptom: a printable
 * key that arrives while the caret is nowhere useful goes in the box.
 */
const press = (over) => ({
  key: 'a',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  target: { tagName: 'DIV' },
  composerHasFocus: false,
  pickerOpen: false,
  ...over
})

check('a letter typed into nothing goes to the box', K.adoptsKeystroke(press()), 'insert')
check(
  'a letter typed at a button goes to the box too',
  K.adoptsKeystroke(press({ target: { tagName: 'BUTTON' } })),
  'insert'
)
check(
  'but never out of another box',
  K.adoptsKeystroke(press({ target: { tagName: 'INPUT' } })),
  'ignore'
)
check(
  'nor out of something being edited in place',
  K.adoptsKeystroke(press({ target: { tagName: 'DIV', isContentEditable: true } })),
  'ignore'
)
check(
  'nothing happens when the box already has it',
  K.adoptsKeystroke(press({ composerHasFocus: true })),
  'ignore'
)
check(
  'a picker keeps the keyboard it asked for',
  K.adoptsKeystroke(press({ pickerOpen: true })),
  'ignore'
)

/* A shortcut is not a character, and Ctrl+C over selected output must copy. */
check('Ctrl+C is left alone', K.adoptsKeystroke(press({ key: 'c', ctrlKey: true })), 'ignore')
check('so is Alt+Up', K.adoptsKeystroke(press({ key: 'ArrowUp', altKey: true })), 'ignore')
check('and Escape', K.adoptsKeystroke(press({ key: 'Escape' })), 'ignore')
check('and Tab', K.adoptsKeystroke(press({ key: 'Tab' })), 'ignore')
check('and the arrows', K.adoptsKeystroke(press({ key: 'ArrowLeft' })), 'ignore')
check('and a function key', K.adoptsKeystroke(press({ key: 'F5' })), 'ignore')

/**
 * Space takes the caret and types nothing. Holding it is how dictation
 * starts, and that machine lives on the textarea's own handler - a space
 * inserted from out here would both leave a character at the front of an
 * empty box and start the hold half way through.
 */
check('space moves the caret without typing', K.adoptsKeystroke(press({ key: ' ' })), 'focus')

/* Punctuation and digits are characters like any other. */
check('a slash starts a command', K.adoptsKeystroke(press({ key: '/' })), 'insert')
check('a digit is a digit', K.adoptsKeystroke(press({ key: '7' })), 'insert')

/* An input method assembling one character out of several keystrokes. */
check(
  'a key mid-composition is left to the input method',
  K.adoptsKeystroke(press({ key: 'n', isComposing: true })),
  'ignore'
)

/* ---------------------- focus dropped by a button that went away */

/**
 * The one cause this round does name. A card's Run button holds the caret,
 * the command runs, the button unmounts - and the browser drops focus on
 * document.body rather than handing it anywhere. The window never lost
 * focus, so no focus event fires and nothing was watching for it.
 *
 * Narrow deliberately: only when the element that had the caret has left
 * the document. Refocusing on every focusout would fight anyone selecting
 * output text with the mouse.
 */
check('the composer watches for focus being dropped', composer.includes('focusout'), true)
check(
  'and only acts when the element actually went away',
  composer.includes('document.contains(left)'),
  true
)
check(
  'and leaves a deliberate move to something else alone',
  composer.includes('if (e.relatedTarget) return'),
  true
)

/*
 * A start in the tray must not report a focus failure.
 *
 * `npm run restart` starts hidden now, so the page loads with the window
 * hidden and the insist loop runs against a window nobody summoned: every
 * single start logged "gave up waiting for the keyboard" and asked main to
 * take the foreground by force. The test is made at the deadline rather than
 * at the start, because a hotkey summon can still read as hidden for a frame
 * or two after show() and focusing during that gap is the whole point.
 */
check(
  'a hidden panel does not cry about the keyboard',
  /!state\.yielded && !state\.tucked/.test(focusSrc),
  true
)
check(
  'and it is still tried while hidden',
  focusSrc.indexOf('el.focus({ preventScroll: true })') > focusSrc.indexOf('!state.tucked'),
  true
)
/*
 * And "hidden" is not document.hidden, which this window never reports:
 * backgroundThrottling is off, so Chromium calls the page visible for as
 * long as it exists. Main is asked instead.
 */
check('the tray state is passed in', /isTucked: \(\) => boolean/.test(focusSrc), true)
check('and the composer passes it', /\(\) => tucked$/m.test(composer), true)


/* ---------------------------------------- moving between the panel's parts */

/**
 * The parts were navigable; getting between them was not.
 *
 * The composer holds the caret almost always, Tab from there walks forward
 * into the transcript, and Shift+Tab was spent on the approval mode - so the
 * header's buttons and the status bar's could only be reached by tabbing
 * forward through every message on screen until it wrapped. Pinning, moving
 * the panel, changing the model and reading the quota were mouse-only in
 * practice, in a window whose whole point is that it opens on a keystroke.
 */
check('the ring is screen order', [...K.REGIONS], ['header', 'transcript', 'status', 'composer'])
check('F6 from the box wraps to the header', K.regionAfter('composer', false, () => true), 'header')
check('Shift+F6 goes to the strip above it', K.regionAfter('composer', true, () => true), 'status')
check('and onwards', K.regionAfter('header', false, () => true), 'transcript')
check('and backwards', K.regionAfter('transcript', true, () => true), 'header')
// Focus lands on the body whenever a button disappears from under it - a card
// that finished, a picker that closed. The first F6 after that should move
// off the box, not onto it.
check('from nowhere it steps off the box', K.regionAfter(null, false, () => true), 'header')

// A region with nothing to land on would swallow the keystroke and leave
// focus where it was, which is indistinguishable from a broken key. So the
// walk asks, rather than assuming all four are there: the status bar drops
// parts of itself in a corner dock, and a transcript of plain answers has no
// controls in it at all.
check(
  'an empty region is skipped',
  K.regionAfter('composer', false, (r) => r !== 'header'),
  'transcript'
)
check(
  'and so are two in a row',
  K.regionAfter('composer', false, (r) => r === 'status'),
  'status'
)
check('nowhere to go answers null', K.regionAfter('composer', false, () => false), null)
check(
  'and it never lands back where it started',
  K.regionAfter('composer', false, (r) => r === 'composer'),
  null
)
check('the walk cannot run off the end', K.regionAfter('header', true, () => true), 'composer')

// Where in a region focus lands. The transcript reads bottom-up: the newest
// proposal is the one the keys are nearly always for, and it is the same end
// Ctrl+Down picks, so the two ways in agree.
check('the transcript is entered at its end', K.entryIndex('transcript', 4), 3)
check('a strip at its start', K.entryIndex('status', 4), 0)
check('the header too', K.entryIndex('header', 2), 0)
check('nothing focusable answers -1', K.entryIndex('status', 0), -1)

check("F6 is bound to the panel's regions", /e\.key === 'F6'/.test(app), true)
check('Shift+F6 is the same key backwards', /stepRegion\(e\.shiftKey\)/.test(app), true)
check(
  'and it only swallows the key when it moved',
  /if \(stepRegion\(e\.shiftKey\)\) e\.preventDefault\(\)/.test(app),
  true
)
check('the newest proposal is the landing spot', /\.cmd, \.ask[\s\S]{0,200}newest/.test(app), true)
check('the transcript itself can be landed on', /tabIndex=\{-1\}/.test(app), true)
check('and says so when it is', /\.scroll:focus-visible/.test(styles), true)
check('a strip you have stepped into is marked', /\.status:focus-within/.test(styles), true)

/**
 * Shift+Tab is the only way back through a row of controls, and the approval
 * cycle had taken it everywhere.
 *
 * So the keyboard was one-directional outside the box: you could step into
 * the header and then only ever go forward, and the attempt to go back
 * changed what runs without asking. It belongs to the composer, which is
 * what it was added for and the one place where there is nothing behind you
 * to walk back to.
 */
check(
  'Shift+Tab cycles approval only from the box',
  /from !== null && from !== 'composer'\) return/.test(app),
  true
)
check(
  'and it is the region that decides',
  /regionOf\(e\.target as Element \| null\)/.test(app),
  true
)
/**
 * And it is Ctrl+Tab, not F6.
 *
 * F6 is the Windows convention for this and nobody remembers it: "don't make
 * it too hard to remember - like function 16, like what the hell, function
 * 6, like what the hell". Tab already means the next thing, so Ctrl+Tab is
 * the same idea with nothing to memorise. F6 still works, and is named in
 * the row rather than given one of its own - two rows for one motion is the
 * sort of thing that makes a key table unreadable.
 */
check('Ctrl+Tab moves between the parts', /e\.key === 'Tab' && e\.ctrlKey/.test(app), true)
check(
  'and it is listed where the other keys are',
  cmds.KEY_ONLY.some((k) => k.keys.includes('Ctrl+Tab')),
  true
)
check(
  'with F6 named beside it',
  cmds.KEYS.some((k) => k.keys.includes('Ctrl+Tab') && k.what.includes('F6')),
  true
)
// The slash-command completion in the box takes plain Tab. A half-typed
// command must not be a place where Ctrl+Tab stops working.
check('the completion lets Ctrl+Tab past', /'Tab' && !e\.shiftKey && !e\.ctrlKey/.test(composer), true)

/* ------------------------------------------------- keys that are not ours */

/**
 * F1 and F2 belong to the user: "don't use my f1 or f2 those are essential".
 *
 * Wumpy floats over whatever they were working in and opens on a keystroke,
 * so a key that matters in the thing underneath matters while this is open
 * too. F1 was bound to /help here for about an hour - a reasonable
 * convention, and not reasonable on this machine.
 *
 * Asserted by name rather than remembered, because the next obvious place to
 * put a help key is exactly there.
 */
for (const key of ['F1', 'F2']) {
  for (const [name, src] of [
    ['the panel', app],
    ['the composer', composer],
    ['the picker', read('src/renderer/src/components/Picker.tsx')]
  ]) {
    check(`${key} is left alone by ${name}`, src.includes(`'${key}'`), false)
  }
  check(`and ${key} is not in the key table`, cmds.KEYS.some((k) => k.keys.includes(key)), false)
}

// What took its place. Ctrl+/ is what most applications use for this, and /
// already starts a command here. Ctrl+? is the same chord with Shift, which
// is how people type a question mark and how some layouts reach / at all.
check(
  'Ctrl+/ prints the shortcuts',
  /e\.ctrlKey && !e\.altKey && \(e\.key === '\/' \|\| e\.key === '\?'\)/.test(app),
  true
)
check('and it runs /shortcuts', /kind: 'shortcuts' \}, '\/shortcuts'/.test(app), true)
check(
  'and the table says so',
  cmds.KEYS.some((k) => k.keys === 'Ctrl+/' && (k.runs ?? []).includes('shortcuts')),
  true
)

/* --------------------------------------------- Space presses what has focus */

/**
 * The two features were arguing, and the newer one was winning.
 *
 * The adopter sees every keystroke in the capture phase so that a character
 * typed at a window whose caret is elsewhere still lands in the box. It
 * decided that a button is not a text box and took Space - which is the key
 * that presses a button, in every application on this machine. So the
 * arrows, Ctrl+Down and now F6 could all put focus on a button that then
 * answered to Enter and nothing else.
 */
check('a button takes Space', K.isActivatable({ tagName: 'BUTTON' }), true)
check('so does a link', K.isActivatable({ tagName: 'A' }), true)
check('and a select', K.isActivatable({ tagName: 'SELECT' }), true)
// The picker's rows are divs wearing a role, which is a control to the user
// and to a screen reader either way.
check(
  'a div with a role counts',
  K.isActivatable({ tagName: 'DIV', getAttribute: () => 'button' }),
  true
)
check('a plain div does not', K.isActivatable({ tagName: 'DIV', getAttribute: () => null }), false)
check('nor a textarea', K.isActivatable({ tagName: 'TEXTAREA' }), false)
check('nor nothing at all', K.isActivatable(null), false)
check(
  'Space on a button is left alone',
  K.adoptsKeystroke({
    key: ' ',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: { tagName: 'BUTTON' },
    composerHasFocus: false,
    pickerOpen: false
  }),
  'ignore'
)
// And still caught everywhere else, because holding it is how dictation
// starts and that machine lives on the textarea's own handler.
check(
  'Space with focus nowhere still reaches the box',
  K.adoptsKeystroke({
    key: ' ',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: { tagName: 'BODY' },
    composerHasFocus: false,
    pickerOpen: false
  }),
  'focus'
)
// A letter typed at a focused button is still a message being written: the
// whole point of the adopter is that a character never disappears.
check(
  'but a letter still goes to the box',
  K.adoptsKeystroke({
    key: 'a',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: { tagName: 'BUTTON' },
    composerHasFocus: false,
    pickerOpen: false
  }),
  'insert'
)

/* ------------------------------------------------- getting down a long list */

/**
 * The command list is sixty rows now that the keys are listed in it.
 *
 * Arrows and a filter were the whole of it, so reaching the bottom meant
 * holding a key down or already knowing what to type - and the keys that
 * exist for this were doing nothing: PageDown went to the window handler,
 * which tried to scroll a transcript that is not even mounted while a picker
 * is open.
 */
const pickerSrc = read('src/renderer/src/components/Picker.tsx')
check('a list pages', /e\.key === 'PageDown' \|\| e\.key === 'PageUp'/.test(pickerSrc), true)
check('by a fixed number of rows', /const PAGE = 8/.test(pickerSrc), true)
check('and jumps to its ends', /e\.ctrlKey && \(e\.key === 'Home' \|\| e\.key === 'End'\)/.test(pickerSrc), true)
// Plain Home and End are how you get to the front of what you typed in the
// filter box. Ctrl+Home and Ctrl+End already mean "the ends of the thing you
// are looking at" everywhere else in the panel.
check(
  'plain Home stays with the filter box',
  /else if \(e\.key === '(Home|End)'/.test(pickerSrc),
  false
)
check(
  'the ends skip anything unpickable',
  /order\.find\(\(i\) => !visible\[i\]\.disabled\)/.test(pickerSrc),
  true
)
// Or the window handler acts on them as well, and a picker is meant to own
// the keyboard while it is open.
check('and the keys stop at the picker', /stopPropagation\(\)\n\s*move\(/.test(pickerSrc), true)

console.log(failures ? `\n${failures} keyboard checks FAILED` : '\nall keyboard checks')
process.exitCode = failures ? 1 : 0

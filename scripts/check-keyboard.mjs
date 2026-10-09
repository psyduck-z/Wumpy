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

// Risky commands are the deliberate exception: the verdict refuses auto for
// them whatever the mode, so those buttons come back on purpose.
const mainSrc = read('src/main/index.ts')
check(
  'risk still overrides accept-all',
  mainSrc.includes("const risky = risk !== null && settings.get('confirmRisky')"),
  true
)
check('and auto requires not-risky', mainSrc.includes('const auto = allowed && !risky'), true)
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

check('showing the panel focuses the box', composer.includes('[focusToken]'), true)
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
check('it still stays off the taskbar', panelSrc.includes('skipTaskbar: true'), true)
// The ordinary route first, so the usual case pays nothing.
check('app.focus is still tried first', /app\.focus\(\{ steal: true \}\)/.test(panelSrc), true)
// Immediately, inside show(). Measured: the same calls made ~600ms later
// through an IPC round trip do not work, because whatever right to change
// the foreground the process has, it has it then and not after.
check(
  'with a restore fallback when it fails',
  /if \(!win\.isFocused\(\)\)[\s\S]{0,120}win\.minimize\(\)[\s\S]{0,60}win\.restore\(\)/.test(
    panelSrc
  ),
  true
)
// Unconditional minimize/restore would flicker on every single open.
check(
  'and only when it failed',
  /win\.minimize\(\)/.test(panelSrc) && /!win\.isFocused\(\)/.test(panelSrc),
  true
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

console.log(failures ? `\n${failures} keyboard checks FAILED` : '\nall keyboard checks')
process.exitCode = failures ? 1 : 0

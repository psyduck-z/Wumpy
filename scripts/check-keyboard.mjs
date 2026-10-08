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
import { readFileSync } from 'node:fs'

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
check(
  'the tier bar moves with arrows',
  read('src/renderer/src/components/TierBar.tsx').includes('arrowNavigate('),
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
// over asynchronously and a focus() made before that lands is dropped.
check(
  'and tries again on the next frame',
  /requestAnimationFrame\([\s\S]{0,140}preventScroll/.test(composer),
  true
)
// The composer sits at the bottom; focusing it the ordinary way yanks a long
// transcript down to the end, which is not what reopening should do to what
// you were reading.
check('without dragging the transcript to the end', composer.includes('preventScroll: true'), true)

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

console.log(failures ? `\n${failures} keyboard checks FAILED` : '\nall keyboard checks')
process.exitCode = failures ? 1 : 0

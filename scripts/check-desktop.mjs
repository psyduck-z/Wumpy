/**
 * Clicking and typing on the real screen: the grammar, and the arithmetic.
 *
 * Built after a refusal the user rejected: "My Gmail tab is literally open.
 * I'm giving it permission to do it." The refusal was honest - Wumpy could
 * see the screen and could not touch it - so what was needed was the
 * capability, not a prompt telling the model to claim one.
 *
 * Two things are worth checking hard here and they are not the same thing.
 *
 * The GRAMMAR, because a half-understood step is the dangerous kind: a
 * `click 400` with one coordinate must be dropped and named, never guessed
 * at, since a click at an invented coordinate lands on something real.
 *
 * The ARITHMETIC, because it is the part that is silently wrong. The model
 * points at a pixel in a picture that was scaled down from one display, and
 * putting that back on the screen needs the shrink factor AND that display's
 * origin. Drop the origin and every click still works - on the wrong
 * monitor. No error, no exception, just the pointer somewhere else.
 *
 * Run with: npm run check:desktop
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

async function load(entry, tag) {
  const out = `.desktop-check-${tag}.mjs`
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error'
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const S = await load('src/shared/steps.ts', 'steps')
const G = await load('src/shared/guard.ts', 'guard')

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const plan = (...lines) => S.readPlan(lines.join(NL))
const kinds = (p) => p.steps.map((s) => s.kind)

/* ------------------------------------------------------------- the grammar */

const gmail = plan('# Click the Gmail tab then Compose', 'click 150 18', 'wait 800', 'click 96 230')
check('the reason is read', gmail.reason, 'Click the Gmail tab then Compose')
check('the steps are read in order', kinds(gmail), ['click', 'wait', 'click'])
check('and nothing is reported as a problem', gmail.problems, [])
check('a click keeps its coordinates', [gmail.steps[0].x, gmail.steps[0].y], [150, 18])

check('rightclick', kinds(plan('rightclick 5 5')), ['click'])
check('and is marked right', plan('rightclick 5 5').steps[0].button, 'right')
check('doubleclick is two', plan('doubleclick 5 5').steps[0].times, 2)
check('a plain click is one', plan('click 5 5').steps[0].times, 1)
check('a comma works as well as a space', [plan('click 7,9').steps[0].x, plan('click 7,9').steps[0].y], [7, 9])

check('type keeps the text verbatim', plan('type Stanley Wong').steps[0].text, 'Stanley Wong')
check('type keeps inner punctuation', plan('type a@b.com, c@d.com').steps[0].text, 'a@b.com, c@d.com')
check('key is normalised', plan('key ctrl + a').steps[0].chord, 'ctrl+a')
check('wait is a number', plan('wait 250').steps[0].ms, 250)

/* ---------------------------------------------- half-understood is dropped */

/*
 * The whole point. A step that cannot be read completely is not run, because
 * the alternative is a click at a coordinate nobody wrote down.
 */
const broken = plan('click 400', 'click x y', 'click -5 10', 'type', 'key !!', 'wait soon', 'frobnicate 1')
check('nothing half-read survives', broken.steps, [])
check('and every one is named', broken.problems.length, 7)
check('a missing coordinate is reported', broken.problems[0].includes('needs two numbers'), true)
check('a negative coordinate is reported', broken.problems[2].includes('negative'), true)
check('an unknown verb is reported', broken.problems[6].includes('not a step'), true)

/* The good steps around a bad one still run; only the bad one is dropped. */
const mixed = plan('click 1 1', 'click oops', 'type hello')
check('a bad step does not poison the good ones', kinds(mixed), ['click', 'type'])
check('and is still reported', mixed.problems.length, 1)

/* ------------------------------------------------------------- the ceilings */

const many = plan(...Array.from({ length: 20 }, (_, i) => `click ${i} ${i}`))
check('a runaway plan is cut off', many.steps.length, S.MAX_STEPS)
check('and says it was', many.problems.some((p) => p.includes('more than')), true)

check('a huge type is dropped', plan(`type ${'x'.repeat(S.MAX_TYPE + 1)}`).steps, [])
check('a long wait is clamped, not dropped', plan('wait 999999').steps[0].ms, S.MAX_WAIT)

/* --------------------------------------------------------- the arithmetic */

/*
 * A 2560x1440 second monitor sitting to the right of a 1920x1080 primary,
 * photographed and shrunk to 1568 on the long edge. These are the numbers
 * that go wrong quietly.
 */
const SECOND = {
  displayX: 1920,
  displayY: 0,
  displayWidth: 2560,
  displayHeight: 1440,
  imageWidth: 1568,
  imageHeight: 882
}
check('the top-left of the image is the top-left of that display', S.toScreen(SECOND, 0, 0), { x: 1920, y: 0 })
check('the middle maps to the middle', S.toScreen(SECOND, 784, 441), { x: 3200, y: 720 })
check('the far corner stays on that display', S.toScreen(SECOND, 1567, 881), { x: 4478, y: 1438 })

/* The origin is the term that is easy to forget and impossible to see. */
const PRIMARY = { ...SECOND, displayX: 0, displayY: 0, displayWidth: 1920, displayHeight: 1080, imageHeight: 882 }
check('the same pixel on the primary is a different screen point', S.toScreen(PRIMARY, 784, 441), { x: 960, y: 540 })
check('the two differ by the display origin', S.toScreen(SECOND, 0, 0).x - S.toScreen(PRIMARY, 0, 0).x, 1920)

/* A display that was NOT shrunk: the factor must be exactly 1, not near it. */
const SMALL = { displayX: 0, displayY: 0, displayWidth: 1280, displayHeight: 800, imageWidth: 1280, imageHeight: 800 }
check('an unshrunk shot maps one to one', S.toScreen(SMALL, 640, 400), { x: 640, y: 400 })

check('a point on the image is on the image', S.onShot(SECOND, 0, 0), true)
check('the last pixel is still on it', S.onShot(SECOND, 1567, 881), true)
check('one past the edge is not', S.onShot(SECOND, 1568, 0), false)
check('and nor is a negative', S.onShot(SECOND, -1, 5), false)

/* ------------------------------------- typing must be aimed by a click */

/*
 * Found the hard way. A test typed into Wumpy's own composer: the helper
 * said "TYPE ok chars=16", the composer stayed empty, and all sixteen
 * characters went to the Windows Terminal that happened to hold the
 * keyboard. SendInput does not aim - it posts to whatever has focus.
 */
const inputSrc = readFileSync('src/main/input.ts', 'utf8')
check('a plan that types without clicking is refused', /typingIsAimed/.test(inputSrc), true)
check('and the refusal runs before any step does', inputSrc.indexOf('typingIsAimed(plan.steps)') < inputSrc.indexOf('for (const step of plan.steps)'), true)
check('a key press counts as typing too', /s\.kind === 'type' \|\| s\.kind === 'key'/.test(inputSrc), true)
/*
 * A COORDINATE CLICK NO LONGER SATISFIES IT, and that is the whole lesson of
 * the Gmail log: ten rounds of `click 620 380` / `type "Stanley"`, every one
 * reporting ok, every one missing the recipient box - so the letters became
 * Gmail keyboard shortcuts and opened three empty compose windows.
 *
 * Pressing by name focuses the control and says which one it chose, so that
 * still aims the keyboard. fill goes further and reads the box back.
 */
check('a bare click no longer aims the keyboard', /s\.kind === 'press' \|\| s\.kind === 'fill'/.test(inputSrc), true)
check('and the refusal names fill as the way to do it', /fill "To recipients"/.test(inputSrc), true)
check('and says why, in the words it was reported in', /empty compose windows/.test(inputSrc), true)

/* ------------------------------------------------------------ the wiring */

const main = readFileSync('src/main/index.ts', 'utf8')
const input = readFileSync('src/main/input.ts', 'utf8')
const fences = readFileSync('src/shared/fences.ts', 'utf8')
const assistant = readFileSync('src/shared/assistant.ts', 'utf8')

check("'do' is a fence tag", /'do'/.test(fences), true)
check('main parses the block itself', /readPlan\(req\.body\)/.test(main), true)
check('and does not trust a parse from the page', /readPlan\(/.test(readFileSync('src/preload/index.ts', 'utf8')), false)
check('it is refused with browser control off', /browserEnabled'\)\)\s*\{[\s\S]{0,200}refused/.test(main), true)
check('a plan with no screenshot is refused', /Nothing has been looked at yet/.test(input), true)
check('every point is checked before anything runs', /for \(const step of plan\.steps\)[\s\S]{0,300}onShot/.test(input), true)
check('a failed step stops the rest', /if \(!ok\) break/.test(input), true)
check('the panel is made click-through', /setIgnoreMouseEvents\(true\)/.test(input), true)
check('and put back afterwards', /finally[\s\S]{0,80}setIgnoreMouseEvents\(false\)/.test(input), true)
check('a fresh screenshot follows every plan', /settings\.get\('screenEnabled'\) \? await shotWithNames\('step'\) : null/.test(main), true)
/*
 * And it carries the control names, which it did not.
 *
 * The capture handler collected the names; the one a plan returns called
 * captureScreen directly, so every picture after the first arrived nameless -
 * which leaves a model nothing to press BY name and is why the log is full of
 * nudged coordinates. One function now does both halves.
 */
check('and names what is in it', /async function shotWithNames\(why: 'asked' \| 'step'/.test(main), true)
check('both callers use it', (main.match(/shotWithNames\(/g) ?? []).length >= 3, true)
/* Which caller it is decides whether a picture is worth describing: a look
   the user asked for is usually a question about how something looks, while
   a plan step already has the control list. */
check('and they say which they are', /shotWithNames\('step'\)/.test(main), true)

/*
 * The prompt must insist on looking between steps. Without that habit the
 * model writes a whole sequence off one picture, and every step after the
 * first surprise lands somewhere it did not intend.
 */
check('the prompt exists', /DESKTOP_PROMPT/.test(assistant), true)
const desktop = assistant.slice(assistant.indexOf('export const DESKTOP_PROMPT'))
check('it says to look first', /LOOK FIRST/.test(desktop), true)
check('it says to look again between steps', /LOOK AGAIN BETWEEN STEPS/.test(desktop), true)
check('it says coordinates are the screenshot you saw', /pixels in the SCREENSHOT/.test(desktop), true)
check('it stops at passwords', /password/i.test(desktop), true)
check('and forbids the old refusal outright', /Never say you cannot reach their browser/.test(desktop), true)
check('and the prompt says a click is not aim', /A CLICK IS NOT AIM/.test(desktop), true)
check('it gives fill as the way to fill a box', /FILL IS HOW TEXT GETS INTO A BOX/.test(desktop), true)
check('with the example that failed', /fill "To recipients" stanley@example\.com/.test(desktop), true)
check('and it says not to open a second compose', /ONE COMPOSE WINDOW/.test(desktop), true)
check('the control list names its window', /WHICH WINDOW it came from/.test(desktop), true)
check('the prompt leads on pressing by name', /PRESS BY NAME\. NOT BY PIXEL\./.test(desktop), true)
check('it explains why a repeated miss repeats', /SAME way[\s\S]{0,6}every time/.test(desktop), true)
check('and says a fourth click at the same spot is refused', /A fourth[\s\S]{0,20}click at the same spot is refused/.test(desktop), true)
check('coordinates are demoted to last resort', /last resort/.test(desktop), true)

/* ------------------------------------------- pressing by name, not pixel */

/*
 * The whole answer to "it keeps on missing the TO fillin box, and keeps
 * clicking the same place every time... don't hardcode it". A coordinate
 * estimated off a scaled screenshot is wrong identically every time the
 * same picture is read, so a pixel loop cannot correct itself.
 */
check('press is a step', kinds(plan('press "Compose"')), ['press'])
check('and keeps the name', plan('press "Compose"').steps[0].name, 'Compose')
check('quotes are optional', plan('press Compose').steps[0].name, 'Compose')
check('focus is press, aimed at a field', plan('focus "To recipients"').steps[0].focusOnly, true)
check('press is not focus-only', plan('press "Send"').steps[0].focusOnly, false)
check('a nameless press is dropped', plan('press ').steps, [])
check('a name with spaces survives', plan('press "To recipients, Press Delete"').steps[0].name, 'To recipients, Press Delete')

check('a name plan needs no screenshot', /needsFrame/.test(inputSrc), true)
check('press sends no coordinate', /PRESS.*toBase64|Buffer\.from\(step\.name/.test(inputSrc), true)
check('the element list is read from the helper', /visibleElements/.test(inputSrc), true)
check('and attached to every screenshot', /visibleElements\(/.test(main), true)

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the model is given the names', /namedControls/.test(app), true)
check('and told to press rather than guess', /rather than guessing a pixel/.test(app), true)

/* ------------------------------------------- the app speaking, not the user */

check('auto-sent turns are marked', /automatic: true/.test(readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')), true)
check('and are not drawn in the transcript', /filter\(\(m\) => !m\.automatic\)/.test(app), true)
check('the screenshot turn says it was automatic', /taken automatically/.test(app), true)
check('and tells the model the user did not speak', /not sent[\s\S]{0,40}by the user/.test(app), true)
check('the plan report is passive too', /carried out automatically/.test(app), true)

/* ----------------------------------- stopping when somebody else is there */

/*
 * "if it detects that it's on the wrong page or like you're interfering make
 * it stop wait or something... Otherwise, I might like mess up some stuff."
 *
 * Stop, not wait: waiting assumes the interruption is momentary and that the
 * screen will come back to how it was, and neither is knowable from here.
 */
check('a guard snapshot is taken first', /readGuard\(send\)/.test(inputSrc), true)
check('and re-read between steps', /ran\.length > 0[\s\S]{0,120}readGuard/.test(inputSrc), true)

/*
 * The rules themselves, run rather than grepped.
 *
 * They used to be checked by searching input.ts for the words it prints,
 * because the parsing needed a subprocess to reach. Both halves are pure now
 * and live in @shared/guard, which matters most for the regex: a pattern that
 * stops matching reports "nothing has happened" forever, and a quiet machine
 * is exactly what that looks like.
 */
const GUARD_LINE =
  'GUARD ok hwnd=7603718 cursor=225,217 keyms=-1 clickms=-1 click=none mousehook=on ' +
  'title=RG93bmxvYWQgV2luZG93cyAxMQ=='
{
  const g = G.parseGuard(GUARD_LINE)
  check('a real guard line parses', g !== null, true)
  check('the window is read', g.hwnd, '7603718')
  check('the pointer is read', [g.cursorX, g.cursorY], [225, 217])
  check('the title is decoded', g.title, 'Download Windows 11')
  check('never-pressed reads as -1', [g.keyMs, g.clickMs], [-1, -1])
  check('and the click kind comes through', g.clickWhat, 'none')

  /* clickms= must not be mistaken for click=, which is the one way this
     pair of patterns can quietly swap places. */
  const busy = G.parseGuard(
    'GUARD ok hwnd=1 cursor=0,0 keyms=4000 clickms=120 click=left-click mousehook=on title='
  )
  check('a recent click is read as a click', busy.clickMs, 120)
  check('and named, not confused with its own age', busy.clickWhat, 'left-click')

  /* An older helper reports neither, and must still parse. */
  const old = G.parseGuard('GUARD ok hwnd=9 cursor=5,5 keyms=800 title=')
  check('a helper without the click fields still parses', old !== null, true)
  check('with the click unknown rather than now', old.clickMs, -1)

  check('a failure is not a guard', G.parseGuard('GUARD FAILED whatever'), null)
  check('nor is an empty line', G.parseGuard(''), null)
}

{
  const at = (o) => ({
    hwnd: '1',
    title: 'Gmail',
    cursorX: 100,
    cursorY: 100,
    keyMs: -1,
    clickMs: -1,
    clickWhat: 'none',
    ...o
  })
  const before = at({})
  check('an untouched machine does not stop a plan', G.interference(before, at({}), 500), null)
  /*
   * A CHANGED WINDOW NO LONGER STOPS IT, which is the fix for the thing that
   * made every plan unfinishable. From the log, one millisecond apart:
   *
   *   [18:30:21.163] [do] Click at 600, 380 -> CLICK ok
   *   [18:30:21.352] [do] stopped: the foreground window changed to
   *                       "Inbox - ... Gmail ... - Microsoft Edge Dev"
   *
   * The plan's own click activated the window it clicked in, and the guard
   * read that as the user coming back. Our clicks are filtered out of the
   * key and click clocks, so "the window moved and the user did nothing" is
   * this app's own doing.
   */
  check(
    'a changed window alone does not stop it',
    G.interference(before, at({ hwnd: '2', title: 'Notepad' }), 500),
    null
  )
  check(
    'it is reported instead',
    G.windowMoved(before, at({ hwnd: '2', title: 'Notepad' })),
    'the foreground window is now "Notepad"'
  )
  check('and the same window is not news', G.windowMoved(before, at({})), null)
  check(
    'the baseline moves with it',
    G.rebase(before, at({ hwnd: '2', title: 'Notepad', cursorX: 900 })).hwnd,
    '2'
  )
  /* But never the user's own clocks: a plan cannot forgive itself for a
     keystroke they made while it was running. */
  check(
    'but never their keyboard',
    G.rebase(at({ keyMs: -1 }), at({ hwnd: '2', keyMs: 10 })).keyMs,
    -1
  )
  check(
    'and a rebased plan still stops for them',
    G.interference(
      G.rebase(before, at({ hwnd: '2', title: 'Notepad' })),
      at({ hwnd: '2', title: 'Notepad', keyMs: 100 }),
      500
    ),
    'you typed something'
  )
  check(
    'a keystroke of theirs stops it',
    G.interference(before, at({ keyMs: 200 }), 500),
    'you typed something'
  )
  check(
    'one from before the plan does not',
    G.interference(before, at({ keyMs: 900 }), 500),
    null
  )
  check(
    'a click of theirs stops it',
    G.interference(before, at({ clickMs: 100, clickWhat: 'left-click' }), 500),
    'you clicked something'
  )
  check(
    'their wheel says so in its own words',
    G.interference(before, at({ clickMs: 100, clickWhat: 'wheel' }), 500),
    'you scrolled'
  )
  check(
    'a click from before the plan does not stop it',
    G.interference(before, at({ clickMs: 2000, clickWhat: 'left-click' }), 500),
    null
  )
  check(
    'the mouse moving stops it',
    G.interference(before, at({ cursorX: 400 }), 500),
    'the mouse moved'
  )
  check(
    'a desk knock does not',
    G.interference(before, at({ cursorX: 100 + G.POINTER_SLACK - 1 }), 500),
    null
  )
  check('the pointer has some slack', G.POINTER_SLACK > 10, true)
  /* With the window out of it, the user's own keyboard is the first thing
     named - it is the most specific evidence that they are back. */
  check(
    'their keyboard is named first',
    G.interference(before, at({ hwnd: '3', title: 'Other', keyMs: 1, clickMs: 1 }), 500),
    'you typed something'
  )
}

check('and ours are never counted as theirs', /dwExtraInfo == WumpySignature/.test(readFileSync('src/hook/Program.cs', 'utf8')), true)
check('only real keystrokes are recorded', /if \(!injected && isDown\) _lastRealKey/.test(readFileSync('src/hook/Program.cs', 'utf8')), true)
check('a missing guard does not block the plan', /a missing guard is a reason to watch less closely/.test(inputSrc), true)
check('it says how many steps did not run', /did not run/.test(inputSrc), true)
check('the model is told it stopped', /STOPS BY ITSELF/.test(desktop), true)
check('and told to look rather than retry', /not a failure to retry/.test(desktop), true)

const card = readFileSync('src/renderer/src/components/DoCard.tsx', 'utf8')
check('the card says interrupted, not failed', /interrupted/.test(card), true)

/* ------------------------------------------- the short way to be seen */

const cmds = readFileSync('src/renderer/src/commands.ts', 'utf8')
check('/screen exists', /name: 'screen'/.test(cmds), true)
check('and takes the question with it', /kind: 'screen'; ask: string/.test(cmds), true)
check('it sends the picture in one turn', /A screenshot of my screen is attached/.test(app), true)
check('with the control names too', /\.\.\.namedControls\(shot\)/.test(app), true)
check('and is visible, unlike the automatic ones', /hiding it would lose the only/.test(app), true)

/* ------------------------------------------- reading, revealing, scrolling */

/*
 * Three things a plan could not do, each of which had been worked around
 * badly.
 *
 * READ: checking your own work meant another screenshot - about 1,100 tokens
 * of a free tier that runs out, and a picture the model then has to read. The
 * question was always "is 'Stanley' in the To box", which the box can answer.
 *
 * REVEAL: the element list only reports what is on screen, so anything below
 * the fold did not exist as far as a plan was concerned. Pressing it meant a
 * wheel over a guessed coordinate, which is the pixel-guessing this whole
 * file exists to replace.
 *
 * SCROLL: the fallback for a canvas or a map, where there are no names at
 * all. The sign is the easy thing to get wrong - Windows scrolls UP on a
 * positive wheel delta - so "down" is pinned here.
 */
check('read is a step', S.readPlan('read "To recipients"').steps, [
  { kind: 'read', name: 'To recipients' }
])
check('reveal is a step', S.readPlan('reveal "Send"').steps, [{ kind: 'reveal', name: 'Send' }])
check('both need a name', S.readPlan('read').problems.length, 1)
check('and say so rather than guessing', /needs the name/.test(S.readPlan('reveal').problems[0]), true)

check('scroll takes a direction and a count', S.readPlan('scroll down 3').steps, [
  { kind: 'scroll', x: -1, y: -1, notches: 3 }
])
check('up is negative', S.readPlan('scroll up 2').steps[0].notches, -2)
check('a bare direction scrolls a sensible amount', S.readPlan('scroll down').steps[0].notches, 3)
check('and at a point when given one', S.readPlan('scroll 400 300 2').steps, [
  { kind: 'scroll', x: 400, y: 300, notches: 2 }
])
check('no point means wherever the pointer is', S.readPlan('scroll down 1').steps[0].x, -1)
check('a huge scroll is clamped, not refused', S.readPlan('scroll down 400').steps[0].notches, S.MAX_SCROLL)
check('scrolling by nothing is dropped', S.readPlan('scroll 10 10 0').steps.length, 0)
check('and named as pointless', /does nothing/.test(S.readPlan('scroll 10 10 0').problems[0]), true)
check('a negative coordinate is refused', S.readPlan('scroll -5 10 2').steps.length, 0)
check('nonsense is refused', S.readPlan('scroll sideways').steps.length, 0)

check('a read step reads as English', S.describe({ kind: 'read', name: 'To' }), 'Read "To" back')
check(
  'a reveal step too',
  S.describe({ kind: 'reveal', name: 'Send' }),
  'Scroll "Send" into view'
)
check(
  'a scroll says which way and where',
  S.describe({ kind: 'scroll', x: -1, y: -1, notches: 2 }),
  'Scroll down 2 notches where the pointer is'
)
check(
  'and counts one notch properly',
  S.describe({ kind: 'scroll', x: 10, y: 20, notches: -1 }),
  'Scroll up 1 notch at 10, 20'
)

/* Reading a control back does not need a picture, so it must not demand one. */
check('read does not require a screenshot', /s.kind === 'click' \|\| s.kind === 'move'/.test(inputSrc), true)
check('a read decodes what came back', /it says \$\{JSON\.stringify\(back\.text\)\}/.test(inputSrc), true)
/* A read that failed must not come back as an empty box: fill decides whether
   the text landed by comparing what the box says, and "could not read it" has
   to be a third answer rather than "it says nothing". */
check('and a read that failed says so instead', /return \{ text: null, via, exact, raw \}/.test(inputSrc), true)
/* A read from another control with the same name is weaker evidence than one
   from the box itself, and fill says which it had. */
check('a name-only match is admitted in the proof', /read from another control with the same name/.test(inputSrc), true)
check('a scroll at a point needs the frame', /SCROLL FAILED no-screenshot/.test(inputSrc), true)
check('and without one it uses the pointer', /cannot-find-the-pointer/.test(inputSrc), true)

const hook = readFileSync('src/hook/Program.cs', 'utf8')
check('the helper understands SCROLL', /case "SCROLL":/.test(hook), true)
check('and VALUE and REVEAL', /case "VALUE":[\s\S]{0,40}case "REVEAL":/.test(hook), true)
check('down is negated for Windows', /-steps \* WHEEL_DELTA/.test(hook), true)
check('a scroll borrows the pointer and puts it back', /SCROLL ok at=[\s\S]{0,160}restored/.test(hook), true)
check('and refuses to scroll off-screen', /SCROLL REFUSED off-screen/.test(hook), true)

const uia = readFileSync('src/hook/Automation.cs', 'utf8')
check('VALUE prefers the value pattern', /ValuePattern\.Pattern/.test(uia), true)
check('then the text pattern', /TextPattern\.Pattern/.test(uia), true)
check('REVEAL uses ScrollItem', /ScrollItemPattern/.test(uia), true)
check('and looks at offscreen elements, unlike the list', /includeOffscreen/.test(uia), true)
check('all three choose the same element', (uia.match(/Best\(root, want/g) ?? []).length >= 3, true)

/*
 * A TAB IS SELECTED, NOT INVOKED - AND A FOCUS IS NOT A PRESS.
 *
 * "I asked her to go to Gmail. I managed to go to Gmail. The annoying thing
 * is that it uses, like, tabs. What the hell?" From the log of that attempt,
 * three times in eighteen seconds:
 *
 *   Press "Inbox - ... - Gmail" -> PRESS ok via=focus-fallback role=TabItem
 *   the foreground window is now "Online GA Test for Scholarship and 9 more
 *     pages" (ours, carrying on)
 *   Press "Compose" -> PRESS FAILED nothing-named
 *
 * A TabItem supports SelectionItem and not Invoke, so every press fell
 * through to a focus, which does not pick a tab - and said ok. Compose was
 * then looked for in a page that was still behind another tab.
 *
 * The regression this guards is the reappearance of ANY path that reports ok
 * for a focus that was asked to be a press.
 */
check('a tab is selected rather than invoked', /SelectionItemPattern\.Pattern/.test(uia), true)
check('and the selection is read back', /IsSelected/.test(uia), true)
check('a checkbox is toggled', /TogglePattern\.Pattern/.test(uia), true)
/* The printing path, not the string: the comment above the fix quotes the
   log line that caused it, and the quote is the explanation. */
check('a focus is never reported as a press', /\$"\{verb\} ok via=focus-fallback/.test(uia), false)
check('and what cannot be pressed says so', /FAILED cannot-press/.test(uia), true)

/*
 * The other half of the same attempt:
 *
 *   FOCUS ok name="To recipients" role=ComboBox focused=yes
 *   FILL FAILED the text did not land: "To recipients" says "" (via value)
 *
 * Gmail's recipient box is a wrapper whose own value reads empty whatever is
 * typed into it, so the proof failed on a fill that had worked.
 */
check('an empty wrapper is read one level in', /Inner\(el, out var innerVia\)/.test(uia), true)
check('and the look inside is bounded', /seen > 8/.test(uia), true)

/* ------------------------------------------------- pasting instead of typing */

/*
 * `type` is one pair of SendInput events per character. An email body is a
 * thousand of them arriving faster than any human types, and an editor that
 * debounces its input handler drops some - and a block is read line by line,
 * so typed text can never contain a line break at all.
 *
 * The backslash-n in a paste is the fiddly part, and this file has had
 * backslashes eaten in transit before, so the test input is built from the
 * code point rather than written as an escape.
 */
const BS = String.fromCharCode(92)
{
  const plan = S.readPlan(`paste Dear Stanley,${BS}n${BS}nThe notes are attached.`)
  check('paste is a step', plan.steps.length, 1)
  check('the backslash-n becomes a real newline', plan.steps[0].text.split(NL).length, 3)
  check('and the words survive', plan.steps[0].text.startsWith('Dear Stanley,'), true)
  check('a tab too', S.readPlan(`paste a${BS}tb`).steps[0].text, `a${String.fromCharCode(9)}b`)

  check('an empty paste is refused', S.readPlan('paste').steps.length, 0)
  check('and named', /nothing to paste/.test(S.readPlan('paste').problems[0]), true)
  const huge = 'x'.repeat(S.MAX_PASTE + 1)
  check('an absurd paste is dropped', S.readPlan(`paste ${huge}`).steps.length, 0)
  check('with the ceiling named', new RegExp(String(S.MAX_PASTE)).test(S.readPlan(`paste ${huge}`).problems[0]), true)
  check('a paste may be longer than a type', S.MAX_PASTE > S.MAX_TYPE, true)

  check(
    'the card shows a short paste in full',
    S.describe({ kind: 'paste', text: 'hello' }),
    'Paste "hello"'
  )
  const long = S.describe({ kind: 'paste', text: 'y'.repeat(200) })
  check('and a long one by its length', /\(200 characters\)$/.test(long), true)
  check('truncated rather than printed whole', long.length < 120, true)
}

/* Pasting is typing: it must still be aimed at something first. */
check('an unaimed paste is refused like an unaimed type', /s\.kind === 'paste'/.test(inputSrc), true)
check('the clipboard is read before it is written', inputSrc.indexOf('clipboard.readText()') < inputSrc.indexOf('clipboard.writeText(text)'), true)
check('and put back after the paste', /await wait\(250\)[\s\S]{0,80}clipboard\.writeText\(hadText\)/.test(inputSrc), true)
/* One copy of the borrowing, used by both paste and fill: two would be two
   places for the restore to go missing. */
check('fill and paste share the clipboard dance', (inputSrc.match(/pasteText\(/g) ?? []).length >= 3, true)
check('the reply says what happened to it', /clipboard=restored/.test(inputSrc), true)
check('an image cannot be put back, and that is said', /clipboard=REPLACED/.test(inputSrc), true)
check('the guideline says when to paste and when to type', /PASTE ANYTHING LONG/.test(desktop), true)
/*
 * Both of these came out of running the thing rather than reasoning about
 * it. Focus leaves the caret where it was, so a paste landed BESIDE the URL
 * already in the address bar; and a `key escape` reported ok while the box
 * kept its text, because the first Escape only closes Edge's suggestions
 * dropdown. Either one, believed, produces a plan that is confidently wrong.
 */
check('it says focus does not empty the box', /FOCUS DOES NOT EMPTY THE BOX/.test(desktop), true)
check('and how to replace the contents', /key ctrl\+a/.test(desktop), true)
check('it says ok is not the same as worked', /NOT THAT IT WORKED/.test(desktop), true)
check('with the escape that proved it', /only closed the suggestions dropdown/.test(desktop), true)
check('and why type exists at all', /where a keystroke is what a field is expecting/.test(desktop), true)
/*
 * The example has to reach the model as a literal backslash-n, so the source
 * builds it from the code point: written as an escape it becomes a real
 * newline, putting a line break in the middle of an example whose whole
 * subject is how to write a line break.
 *
 * Checked against the BUILT prompt rather than the source text, because the
 * source now says ${BACKSLASH}n and only the built string can prove what the
 * model actually sees.
 */
const A = await load('src/shared/assistant.ts', 'prompt')
const assistantSrc = assistant
const pasteExample = A.DESKTOP_PROMPT.split(NL).find((l) => l.includes('paste Hi Stanley')) ?? ''
check('the example shows a literal backslash-n', pasteExample.includes(`${BS}n${BS}n`), true)
check('and not a real newline', pasteExample.includes('The notes are attached.'), true)
check('the source does not write it as an escape', /paste Hi Stanley,\\n/.test(assistantSrc), false)

/* ----------------------------------------- the click the guard could not see */

/*
 * A click was the one interruption nothing could notice: it presses no key
 * and moves the pointer no further than the hand already was. Someone
 * clicking into another field while a plan typed read as a quiet machine.
 */
check('the helper watches the mouse too', /WH_MOUSE_LL/.test(hook), true)
check('only real clicks are recorded', /if \(!ours && !injected\)/.test(hook), true)
check('the guard reports them', /clickms=/.test(hook), true)
check('and says whether it is watching', /mousehook=/.test(hook), true)
check('a failed mouse hook is not fatal', /WARN mouse hook failed/.test(hook), true)
check('the mouse hook never swallows an event', (hook.match(/CallNextHookEx\(_mouseHook/g) ?? []).length, 2)
/*
 * The strict pattern must stop at keyms, so a helper built before the click
 * fields existed still parses. Requiring them would turn an old binary into
 * no guard at all, which is the dangerous way to fail: the watching simply
 * stops rather than saying anything.
 *
 * Asserted with plain string tests on purpose - a regex matching a regex
 * needs doubled backslashes, and this file has had them eaten in transit
 * before, which is a check that passes while testing nothing.
 */
const guardSrc = readFileSync('src/shared/guard.ts', 'utf8')
const guardLine = guardSrc.split(NL).find((l) => l.includes('GUARD ok hwnd=')) ?? ''
check('the strict pattern stops at keyms', guardLine.includes('keyms='), true)
check('and does not demand the new fields', guardLine.includes('clickms'), false)
check('which are read on their own', guardSrc.includes('/clickms=(-?'), true)
check('along with the title', guardSrc.includes("const title = decode('title')"), true)
check('and the window a plan would act on', guardSrc.includes("decode('target')"), true)
check('and whether the panel is the one in front', guardSrc.includes('own=yes'), true)
check('a click of theirs stops a plan', /you clicked something/.test(guardSrc), true)
check('a scroll of theirs too', /you scrolled/.test(guardSrc), true)
check('the model is told clicks stop it', /CLICKED something/.test(desktop), true)

/* ------------------------------------------------- what the guideline says */

check('the guideline offers read', /read "<name>"/.test(desktop), true)
check('and says why, not just how', /did my typing land in the[\s\S]{0,12}right place/.test(desktop), true)
check('it mentions the cost of a picture', /free[\s\S]{0,20}quota is finite/.test(desktop), true)
check('reveal is preferred over the wheel', /prefer reveal/.test(desktop), true)

/* -------------------------------------------------- fill: the whole point */

/*
 * One step that finds the box, replaces its contents and proves it.
 *
 * It exists because the three steps it replaces were the failure. The log of
 * a real "email Stanley" is `click 620 380`, `type "Stanley"`, `key enter`,
 * ten times at ten nudged coordinates, every one reporting ok - and the
 * user's side of it was three empty drafts with no recipient.
 */
{
  const p = plan('# address it', 'fill "To recipients" stanley@example.com')
  check('fill parses', kinds(p), ['fill'])
  check('and keeps the name and the text apart', [p.steps[0].name, p.steps[0].text], [
    'To recipients',
    'stanley@example.com'
  ])
  check(
    'the name may hold spaces and punctuation',
    plan('fill "To recipients, Press Delete to remove" x').steps[0]?.name,
    'To recipients, Press Delete to remove'
  )
  check(
    'a newline is two characters here as well',
    plan(`fill "Message body" Hi${BS}nthere`).steps[0]?.text.includes(NL),
    true
  )
  check('an unquoted name is refused rather than guessed at', plan('fill To recipients x').steps.length, 0)
  check('and says which half is missing', /name in quotes/.test(plan('fill To x').problems[0] ?? ''), true)
  check('nothing to put in it is not a fill', plan('fill "Subject"').steps.length, 0)
  check('and it points at focus instead', /focus/.test(plan('fill "Subject"').problems[0] ?? ''), true)
  check('a book is not a fill', plan(`fill "Body" ${'x'.repeat(S.MAX_PASTE + 1)}`).steps.length, 0)
  check('the card says what it will do', S.describe(p.steps[0]), 'Put "stanley@example.com" in "To recipients" and check it')
  check('and fill aims the keyboard for what follows', plan('fill "To" a', 'key tab').steps.length, 2)
}

check('fill focuses, selects, pastes and reads back', /focusNamed\(step\.name[\s\S]{0,5000}KEY ctrl\+shift\+home[\s\S]{0,1200}pasteText[\s\S]{0,400}readValue/.test(inputSrc), true)
check('a focus that did not take stops it', /focused=no/.test(inputSrc), true)
/*
 * ONE CLICK, THEN STOP. The recovery a person would do, and the loop it
 * must not become: the Gmail log is six steps that each repeat the one
 * before, which is what the user saw as "it keeps on missing the TO fillin
 * box".
 *
 * The coordinates come from the helper's own reply - UI Automation measured
 * them - rather than from a model estimating off a scaled screenshot, which
 * is the thing this whole file exists to replace.
 */
check('a box that will not take the caret is clicked', /CLICK \$\{at\[1\]\} \$\{at\[2\]\}/.test(inputSrc), true)
check('through the panel, which sits over that half of the screen', /throughThePanel\(panel, \(\) => send\(`CLICK/.test(inputSrc), true)
check('once, not in a loop', (inputSrc.match(/FOCUS \$\{named\(name\)\}/g) ?? []).length, 2)
check('and the second refusal says to stop trying', /Do not try this box again/.test(inputSrc), true)
/* focus and fill share it, because a plan that focuses and then types has
   exactly the same problem as one that fills. */
check('a bare focus gets the same recovery', /focusNamed\(step\.name, panel, send\)/.test(inputSrc), true)
/* fill selects what is in the field and pastes over the selection. That is
   right in a text field and destructive anywhere else - somebody's open
   document - so the role is checked before anything is selected. */
check('and a control that is not a box stops it too', /is a \$\{role\}, not a box text goes into/.test(inputSrc), true)
check('before the select, not after', inputSrc.indexOf('not a box text goes into') < inputSrc.indexOf("send('KEY ctrl+end'"), true)
/*
 * CTRL+A IS NOT A TEXT-FIELD KEY, which the user worked out from their own
 * run: "it pressed Control A, and when it pressed Control A, that's when it
 * unselects the to recipient... it didn't notice."
 *
 * It is an application key, and a web app is free to take it - Gmail's
 * message list answers it by selecting every conversation. ctrl+end and
 * ctrl+shift+home are caret movements that belong to the control holding
 * the caret, and they cannot select anything outside it.
 */
check('the old contents are selected from inside the field', /KEY ctrl\+shift\+home/.test(inputSrc), true)
check('and ctrl+a is not pressed at all', /KEY ctrl\+a/.test(inputSrc), false)
/* An empty box needs no emptying, and the keystrokes that would empty it are
   a chance for the page to do something else instead. The read that decides
   is a UI Automation call, so it cannot be intercepted. */
check('an empty box is not selected first', /const holds = \(before\.text \?\? ''\)\.trim\(\)\.length > 0/.test(inputSrc), true)
check('and the caret is checked again after emptying', /moved the keyboard out of it/.test(inputSrc), true)
check('and nothing is typed in that case', /did not take the keyboard, so nothing was typed/.test(inputSrc), true)
check('a box that still says the wrong thing is a failure', /FILL FAILED the text did not land/.test(inputSrc), true)
check('and an unreadable box is neither', /so this is unproven/.test(inputSrc), true)

/* ------------------------------------------- the same pixel, over and over */

const AIM = await load('src/shared/aim.ts', 'aim')
{
  const now = 1_000_000
  const history = [
    { x: 700, y: 400, at: now - 1000 },
    { x: 710, y: 405, at: now - 2000 },
    { x: 1200, y: 400, at: now - 3000 },
    { x: 700, y: 400, at: now - 10 * 60_000 }
  ]
  check('two nearby clicks count as the same place', AIM.repeats(history, 705, 402, now), 2)
  check('a different place does not', AIM.repeats(history, 300, 300, now), 0)
  check('and one from ten minutes ago is forgotten', AIM.repeats(history, 700, 400, now) < 3, true)
  check('the first time is not worth mentioning', AIM.aimNote(0).note, null)
  check('the third is', /3rd click at this same point/.test(AIM.aimNote(2).note ?? ''), true)
  check('and it is still allowed', AIM.aimNote(2).refuse, false)
  check('the fourth is refused', AIM.aimNote(AIM.TOO_MANY).refuse, true)
  check('with the alternative named', /press "<name>"/.test(AIM.aimNote(AIM.TOO_MANY).note), true)
  check('stale clicks are dropped as they are remembered', AIM.remember(history, { x: 1, y: 1, at: now }, now).length, 4)
}
check('the plan runner refuses a repeated click', /aimNote\(repeats\(aimHistory/.test(inputSrc), true)
/* Across plans, not within one: the ten retries in the log were ten separate
   turns, so anything scoped to a plan would have seen one click each time. */
check('and remembers them across plans', /^let aimHistory/m.test(inputSrc), true)

/* --------------------------------------- never acting on Wumpy's own panel */

/*
 * The bug under all of it. The panel has the keyboard when a plan starts -
 * the user just typed into it - so a lookup against the foreground window
 * searched Wumpy's own transcript. From the log:
 *
 *   PRESS FAILED InvalidOperationException
 *     name=UHJlc3MgIkluYm94IC0gemVjaGFyaWFoIg==  role=ListItem at=1698,547
 *
 * which decodes to `Press "Inbox - zechariah"` - the text of Wumpy's own
 * step card, at the coordinates of the panel.
 */
check('the helper knows which process is Wumpy', /public static uint Owner/.test(uia), true)
check('and the app tells it', /UiTree\.Owner = grantPid/.test(hook), true)
check('a lookup never uses the foreground blindly', /var root = ForegroundTree\(\)/.test(uia), false)
check('it acts on the window a plan should act on', (uia.match(/var root = TargetTree\(\)/g) ?? []).length, 4)
check('which is never one of ours', /if \(Ours\(next\)/.test(uia), true)
check('and is found by walking the z-order', /GW_HWNDNEXT/.test(uia), true)
check('tool windows and tooltips are skipped', /WS_EX_TOOLWINDOW/.test(uia), true)
check('the elements reply names its window', uia.includes('window={Encode(TargetTitle())}'), true)
check('and the model is shown that name', /in "\$\{shot\.window\}"/.test(readFileSync('src/renderer/src/App.tsx', 'utf8')), true)
check('a focus is verified, not assumed', /HasKeyboardFocus/.test(uia), true)
check('and the helper says whether it re-found the same control', uia.includes('matched={(exact ? "spot" : "name-only")}'), true)
check('the nearest match is taken, not the first by name', /bestGap <= 4/.test(uia), true)
/* The list is capped, so what gets cut matters: Gmail reports 971 elements.
   A box you type in is worth more than the fortieth button. */
check('typeable controls are listed first', /"Edit" or "ComboBox" => 0/.test(uia), true)
check('and duplicate names do not fill the cap', /\.GroupBy\(f => \$"\{f\.Role\}/.test(uia), true)
check('focus prefers the box over the label beside it', /preferEditable: focusOnly/.test(uia), true)
/*
 * UI AUTOMATION FOCUS IS NOT THE KEYBOARD.
 *
 * The second Gmail attempt, with the tab bug already fixed:
 *
 *   FOCUS ok via=focus name="To recipients" role=ComboBox focused=yes
 *   FILL FAILED the text did not land: "To recipients" says ""
 *
 * Both true. SetFocus on a Chromium element sets the DOM focus in a window
 * that is not in front, and HasKeyboardFocus says yes; the ctrl+a and ctrl+v
 * that follow go to the foreground window, which while a plan runs is
 * Wumpy's own panel, because Target walks underneath it on purpose.
 *
 * So the verdict needs both halves, and a focus that did not take is a
 * failed step rather than an ok one with a flag on the end - the same rule
 * as the tab above.
 */
check('the window is brought to the front first', /Program\.RaiseNow\(hwnd/.test(uia), true)
check('and the keyboard is only claimed when it is', /via != "none" && front/.test(uia), true)
check('a focus that did not take is a failure', /FAILED did-not-take-keyboard/.test(uia), true)
check('the editable thing inside a wrapper is tried too', /InnerFocusable\(el\)/.test(uia), true)
/* The same activation the panel uses, rather than a bare SetForegroundWindow:
   measured on a real show, that one returns false with the input queues
   joined, which is why there are two levers. */
check('activation is shared, not reinvented', /internal static bool RaiseNow/.test(hook), true)
check('and is bounded, because a command is waiting on it', /worker\.Join\(ms\)/.test(hook), true)
/* The last gate before the characters leave. SendInput goes to the
   foreground window whatever the step thought it was aiming at, so typing
   while the panel is in front types into the panel - which is where
   "stanley" went, three times, reported as ok. */
check('typing into our own panel is refused', /wumpy-has-the-keyboard/.test(hook), true)
check('on both the characters and the chords', (hook.match(/Keyboard\(out var why\)/g) ?? []).length, 2)
check(
  'the report says which window the steps acted on',
  /acted on the window behind it/.test(readFileSync('src/renderer/src/App.tsx', 'utf8')),
  true
)

/* The list is capped and the window has more: say so, because a model that
   believes the list is everything starts guessing pixels for the rest. */
check('the total is carried back from the helper', inputSrc.includes(String.raw`/total=(\d+)/`), true)
check('and reaches the attachment', /elementTotal: named\.total/.test(readFileSync('src/main/index.ts', 'utf8')), true)
check(
  'the model is told the list is the useful part of a longer one',
  /most useful of \$\{shot\.elementTotal\}/.test(readFileSync('src/renderer/src/App.tsx', 'utf8')),
  true
)
check(
  'and that a name off the list still works',
  /search ALL of them/.test(readFileSync('src/renderer/src/App.tsx', 'utf8')),
  true
)

console.log(`${NL}${count - failed}/${count} desktop checks passed`)
if (failed) process.exit(1)

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

const out = '.desktop-check.mjs'
await build({
  entryPoints: ['src/shared/steps.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const S = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

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
check('a click satisfies it', /s\.kind === 'click' \|\| s\.kind === 'press'/.test(inputSrc), true)
/* Pressing by name focuses the control, so it aims the keyboard too - and
   it is the route the model should prefer, so it must not be refused. */
check('and so does pressing a named control', /s\.kind === 'press'/.test(inputSrc), true)

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
check('a fresh screenshot follows every plan', /captureScreen\(panel\.liveWindow\(\)\)[\s\S]{0,40}: null/.test(main), true)

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
check('and the prompt says to aim before typing', /AIM BEFORE YOU TYPE/.test(desktop), true)
check('the prompt leads on pressing by name', /PRESS BY NAME\. NOT BY PIXEL\./.test(desktop), true)
check('it explains why a repeated miss repeats', /SAME way every time/.test(desktop), true)
check('and forbids re-clicking a coordinate that did nothing', /do NOT[\s\S]{0,20}click it again/.test(desktop), true)
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
check('a changed window stops it', /foreground window changed/.test(inputSrc), true)
check('a keystroke of theirs stops it', /you typed something/.test(inputSrc), true)
check('the mouse moving stops it', /the mouse moved/.test(inputSrc), true)
check('the pointer has some slack', /POINTER_SLACK/.test(inputSrc), true)
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

console.log(`${NL}${count - failed}/${count} desktop checks passed`)
if (failed) process.exit(1)

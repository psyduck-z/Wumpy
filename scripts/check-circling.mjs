/**
 * Checks the guard on a plan of clicks that has stopped getting anywhere.
 *
 * Reported, about a quiz on a web page: "after i read the passage and
 * answered the first question, it got stuck after the next few, and kept
 * looking back at the passage, looking to see if there were more questions
 * after Q2, looking back, looking at the options, etc and did the same thing
 * forever".
 *
 * The centre of this file is REPLAY, below: the real sequence out of
 * wumpy.log, step by step, with the byte count and the control count of every
 * screenshot it took. The guard is run over it and has to stop the loop at
 * the step where the loop became a loop - and, just as important, has to NOT
 * stop the five productive steps that came first, or the sequences that look
 * similar and are working.
 *
 * That second half is why this is a check and not a rule of thumb. A guard
 * that fires early turns a feature the user asked for into one that gives up,
 * and the failure mode is invisible: the sequence just stops, and nobody can
 * tell whether it stopped because it was stuck or because the guard was
 * wrong. So the fixtures include typing into three boxes on a form, where
 * every screen has the same controls and nothing is wrong at all.
 *
 * Run with: npm run check:circling
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.circling-check.mjs')
await build({
  entryPoints: ['src/shared/circling.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const C = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
const pad = (s, n) => String(s).padEnd(n)
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 58)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 58)} expected ${JSON.stringify(want)}`)
}

const NL = String.fromCharCode(10)

/**
 * A screen, the way the log records one: so many controls, so many bytes.
 *
 * The real fingerprint also hashes the control NAMES, which can only make it
 * more discriminating - two screens that share a name list and a byte count
 * to the byte are the same picture. Named off the byte count here so the
 * fixtures read like the log does.
 */
const screen = (controls, bytes) =>
  C.screenPrint(
    Array.from({ length: controls }, (_, i) => ({ name: `${bytes}-control-${i}` })),
    bytes
  )

const visit = (step, controls, bytes) => ({
  step: C.shortStep(step),
  screen: screen(controls, bytes),
  controls
})

/* ------------------------------------------------------- what makes a screen */

check('the same names and bytes is the same screen', screen(57, 110482) === screen(57, 110482), true)
/**
 * The half that keeps the guard off working sequences.
 *
 * Typing into the second of three boxes on a form changes no control at all -
 * same names, same count - and a rule resting on names alone would call that
 * going in circles and stop a sequence that was doing exactly what was asked.
 * The bytes move the moment anything on screen does.
 */
check('the same names with new bytes is not', screen(57, 110482) === screen(57, 110500), false)
check('and new names are never the same screen', screen(57, 110482) === screen(39, 110482), false)
/* No controls at all - desktop control off, or a window with none - still
   has to produce something comparable rather than everything matching. */
check('a screen with no controls still prints', screen(0, 131225) === screen(0, 131225), true)
check('and two different ones do not match', screen(0, 131225) === screen(0, 131226), false)

/* ------------------------------------------------------------------- REPLAY */

/**
 * The real loop, out of wumpy.log, 15:02:52 to 15:04:46.
 *
 * Every line is one step the model took and the screenshot that came back.
 * The first five are the sequence working - it read the passage, scrolled to
 * the question, answered it - and from there it oscillates between three
 * scroll positions, seeing byte-identical pictures of each, until the user
 * gave up at 15:06:24 and hid the panel. Twenty-five screenshots, twenty
 * turns, about twenty thousand tokens of context each.
 */
const REPLAY = [
  ['looked at the screen', 24, 131225], //  1  15:02:52
  ['Scroll down 3 notches where the pointer is', 27, 157167], //  2  15:03:01
  ['Scroll down 5 notches where the pointer is', 31, 156766], //  3  15:03:04
  ['Scroll down 5 notches where the pointer is', 47, 135133], //  4  15:03:07
  ['Press "D to demonstrate how relaxed MacEwen was despite the bad weather"', 47, 135255], //  5
  ['Scroll down 5 notches where the pointer is', 47, 135255], //  6  15:03:36 - nothing moved
  ['Scroll up 5 notches where the pointer is', 39, 153529], //  7  15:04:26
  ['Scroll down 5 notches where the pointer is', 57, 110482], //  8  15:04:28
  ['Scroll up 5 notches where the pointer is', 39, 153529], //  9  15:04:33 - 2nd sighting
  ['Scroll down 5 notches where the pointer is', 57, 110482], // 10  15:04:38 - 2nd sighting
  ['Scroll down 5 notches where the pointer is', 59, 105067], // 11  15:04:41
  ['Scroll up 5 notches where the pointer is', 57, 110482] // 12  15:04:46 - 3rd sighting
]

/** The trail as it stood after each step, and what the guard said. */
const after = []
{
  const trail = []
  for (const [step, controls, bytes] of REPLAY) {
    trail.push(visit(step, controls, bytes))
    after.push({
      steps: trail.length,
      stuck: C.stuck(trail),
      circling: C.circlingNote(trail),
      trail: C.trailLines(trail)
    })
  }
}
const at = (n) => after[n - 1]

/* The five that were working are left alone. This is the assertion that
   matters most in the other direction: a guard that fires here takes away
   the feature. */
for (const n of [1, 2, 3, 4, 5]) {
  check(`step ${n} of the working sequence runs`, at(n).stuck, null)
}
/* Step 6 scrolled and nothing moved - the same screen as step 5. Not
   stopped, because once is a legitimate move: look, act, look back. But it
   is said out loud, fifty seconds before the oscillation even starts. */
check('a step that changed nothing is noticed at once', Boolean(at(6).circling), true)
check('and names the step it was already at', at(6).circling.includes('SAME SCREEN AS STEP 5'), true)
check('for the second time', at(6).circling.includes('second time'), true)
check('but twice is not yet a circle', at(6).stuck, null)

/* The oscillation. Two sightings of each position is still not enough. */
check('the 2nd sighting of a position runs on', at(9).stuck, null)
check('and so does the 2nd of the other one', at(10).stuck, null)

/**
 * And the third stops it.
 *
 * 15:04:46 in the log. The loop ran for another ninety-eight seconds and
 * thirteen more screenshots after this, and every one of them was the same
 * three pictures again.
 */
check('the 3rd sighting stops the sequence', Boolean(at(12).stuck), true)
check('saying how many times', at(12).stuck.includes('same screen 3 times'), true)
/* The words are for the model, and what it does next is the whole point. */
check('and what to do instead', at(12).stuck.includes('Answer now'), true)
check('not to propose another step', at(12).stuck.includes('do not propose another step'), true)
/* And for the user, in the card: the sequence is over until they speak. */
check('and that the user is the way out', at(12).stuck.includes('types something'), true)

/* Twelve steps rather than twenty-five, which is the whole fix. */
check('it stops at step 12 of the real log, not never', after.findIndex((a) => a.stuck) + 1, 12)

/* ------------------------------------------- and the sequences that are fine */

/**
 * Nine steps down a long page, a new screen each time. The longest working
 * run in the log is nine; this must not be the thing that breaks it.
 */
{
  const trail = []
  for (let i = 0; i < 9; i++) {
    trail.push(visit('Scroll down 5 notches where the pointer is', 40 + i, 120000 + i * 97))
    if (C.stuck(trail)) {
      failed++
      console.log(`FAIL a productive scroll of nine was stopped at step ${i + 1}`)
    }
  }
  count++
  console.log('ok   nine productive steps are left alone')
  check('and nothing is called a repeat', trail.map(() => null).join(''), C.circlingNote(trail) ?? '')
}

/**
 * Typing into three boxes on a form.
 *
 * The case that would break if the guard rested on the control names, which
 * do not change when a box is filled in. Five steps, same controls
 * throughout, and every screenshot a few hundred bytes different because
 * there are now characters in a box.
 */
{
  const trail = []
  const steps = [
    'Focus "Name"',
    'Type "Jane Chen"',
    'Focus "Email"',
    'Type "jane@example.com"',
    'Press "Submit"'
  ]
  steps.forEach((step, i) => trail.push(visit(step, 31, 98000 + i * 412)))
  check('filling in a form is not going in circles', C.stuck(trail), null)
  check('and none of it reads as a repeat', C.circlingNote(trail), null)
}

/* ------------------------------------------------------------ the backstop */

/**
 * A plan that wanders without ever repeating itself still has to end.
 *
 * Twenty is far more than any real sequence here has needed, and at a
 * screenshot and a model turn each it is already the most expensive thing
 * Wumpy does with nobody watching.
 */
{
  const trail = []
  for (let i = 0; i < C.CHAIN_LIMIT; i++) {
    trail.push(visit(`Click at ${i},${i}`, 20 + i, 50000 + i * 1000))
  }
  check(`${C.CHAIN_LIMIT} steps without an answer is the ceiling`, Boolean(C.stuck(trail)), true)
  check('and it says how many there were', C.stuck(trail).includes(`${C.CHAIN_LIMIT} steps`), true)
  check('one short of it still runs', C.stuck(trail.slice(0, C.CHAIN_LIMIT - 1)), null)
}

/* --------------------------------------------------------------- the memory */

/**
 * The trail is the thing the pictures cannot be.
 *
 * KEEP_PICTURES is 2 - for good reasons, a picture a step is a quadratic
 * cost - so from the third step on, the model genuinely cannot see where it
 * has been. Everything above is a guard; this is the part that lets it
 * answer instead of being stopped.
 */
{
  const lines = at(12).trail
  const text = lines.join(NL)
  check('the trail says why it is there', lines[0].includes('no longer see'), true)
  /* Lettered in the order the screens were first reached, so a letter is
     something a sentence can refer to. */
  check('screens are named', text.includes('screen C'), true)
  /**
   * And the letters are assigned over the WHOLE trail, not the shown window.
   *
   * Steps 1 and 2 have scrolled out of this report, so A and B are not in it
   * - but the position first reached at step 8 is G here and has to still be
   * G in the next report, or a letter means a different screen every turn and
   * the memory is worse than none.
   */
  const earlier = C.trailLines(
    REPLAY.slice(0, 10).map(([step, controls, bytes]) => visit(step, controls, bytes))
  ).join(NL)
  check('a letter means the same screen in every report', earlier.includes('8. Scroll down 5 notches where the pointer is → screen G'), true)
  check('and still does once the start has scrolled out', text.includes('8. Scroll down 5 notches where the pointer is → screen G'), true)
  check('and a screen returned to keeps its letter', (text.match(/screen E/g) ?? []).length >= 2, true)
  check('a revisit says which step it was', text.includes('the same screen you were on at step 7'), true)
  /* Bounded: this is sent on every step of a conversation that is already at
     its context limit. */
  check('only the newest are listed', lines.length - 1, C.TRAIL_SHOWN)
  check('and it says that it is a window', lines[0].includes(`last ${C.TRAIL_SHOWN} of 12`), true)
  /* One step is not a trail. */
  check('one step needs no trail at all', C.trailLines([visit('Click at 1,1', 4, 100)]), [])
}

check('a long step is shortened', C.shortStep('x'.repeat(200)).length, 56)
check('and a short one is left alone', C.shortStep('  Press  "Submit" '), 'Press "Submit"')

/* ------------------------------------------------- it is wired to the real app */

{
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

  /* Refused in the renderer, because the thing being judged is the SEQUENCE
     and main only ever sees one plan. */
  check(
    'a plan is not run when the trail says stop',
    /const why = stuck\(trailRef\.current\)[\s\S]{0,200}refused: why/.test(app),
    true
  )
  /* Both halves of look-act-look feed the same trail, or a run of nothing
     but looks would never reach a ceiling. */
  check(
    'acting adds to the trail',
    /trailRef\.current\.push\(\{[\s\S]{0,160}screen: screenPrint\(after\?\.elements/.test(app),
    true
  )
  check(
    'and looking does too',
    /step: 'looked at the screen',[\s\S]{0,120}screenPrint\(shot\.elements/.test(app),
    true
  )
  /* The report carries the memory and the verdict, in that order. */
  for (const piece of ['...trail]', 'circling ?', 'halted ?']) {
    if (!app.includes(piece)) {
      failed++
      console.log(`FAIL the hand-back does not carry ${piece}`)
    } else count++
  }
  console.log('ok   the trail, the repeat and the stop all reach the model')

  /* Typing is the rule and the way out: the same reset the unattended
     command budget uses. A sequence stopped for circling is stopped until
     the user says something, and "carry on" is a fresh chain. */
  check(
    'the trail starts again when the user types',
    /ranCommandsRef\.current = \[\][\s\S]{0,400}trailRef\.current = \[\]/.test(app),
    true
  )
}

console.log(
  failed === 0
    ? `${NL}all ${count} circling checks correct`
    : `${NL}${failed} of ${count} circling checks FAILED`
)
process.exit(failed === 0 ? 0 : 1)

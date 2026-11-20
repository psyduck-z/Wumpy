/**
 * Checks hold-the-spacebar-to-talk.
 *
 * Every failure here is silent. A timer that outlives the release starts
 * recording after the fact; a repeat treated as a fresh press restarts the delay
 * so the recording never begins; a snapshot taken a moment late eats the word
 * before the space. None of them look like anything until someone is mid-sentence.
 *
 * And the one that matters most is the one that does nothing: a space pressed and
 * released is a space. The spacebar is the most-pressed key there is, so most of
 * this file is about leaving it alone.
 *
 * Run with: npm run check:holdtotalk
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.hold-check.mjs')
await build({
  entryPoints: ['src/renderer/src/holdtotalk.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { HoldToTalk, HOLD_MS, BRIDGE_MS, isPlainSpace } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 50)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 50)} expected ${JSON.stringify(want)}`)
}

const snap = (value = 'hello', caret = 5) => ({ value, caret })
/** Let go at `at`, and nothing pressed after: what the settle timer decides. */
const release = (h, at = 0) => {
  const first = h.up(at)
  if (first.kind !== 'wait') return first
  return { ...h.settle(at + BRIDGE_MS), up: first }
}

/* -------------------------------------------- a space is a space is a space */

{
  const h = new HoldToTalk()
  check('a tap arms, without swallowing the key', h.down(0, snap()).kind, 'arm')
  check('and the space is typed', h.down(0, snap()).swallow, false)
}
{
  const h = new HoldToTalk()
  h.down(0, snap())
  const up = release(h, 50)
  check('releasing early is just a space', up.kind, 'cancel')
  check('and the space stays in the box', up.swallow, false)
  check('back to idle', h.state, 'idle')
}
{
  // The near miss. One millisecond short is still a space.
  const h = new HoldToTalk()
  h.down(0, snap())
  check('a hold one ms short does not listen', h.tick(HOLD_MS - 1).kind, 'nothing')
  check('still armed, not listening', h.state, 'armed')
  check('and then it is a space', release(h, HOLD_MS - 1).kind, 'cancel')
}

/* ----------------------------------------------------------- a real hold */

{
  const h = new HoldToTalk()
  h.down(0, snap('type this ', 10))
  const listen = h.tick(HOLD_MS)
  check('exactly the delay listens', listen.kind, 'listen')
  check('the key is swallowed from here on', listen.swallow, true)
  check('the text goes back to before the space', listen.restore, {
    value: 'type this ',
    caret: 10
  })
  check('state is listening', h.state, 'listening')

  const send = release(h, 2000)
  check('releasing sends it', send.kind, 'send')
  check('and that release is not a space', send.up.swallow && send.swallow, true)
  check('idle again', h.state, 'idle')
}

/* --------------------------------------------------------- auto-repeat */

/**
 * Windows repeats a held key around thirty times a second, and each repeat is
 * another keydown. Two things must not happen: the delay must not restart, and
 * once recording the repeats must not reach the box.
 */
{
  const h = new HoldToTalk()
  h.down(0, snap())
  let restarted = 0
  for (let t = 30; t < HOLD_MS; t += 30) {
    if (h.down(t, snap('WRONG', 0)).kind === 'arm') restarted++
  }
  check('repeats never re-arm', restarted, 0)

  const listen = h.tick(HOLD_MS)
  check('the delay still elapses', listen.kind, 'listen')
  check('and the first snapshot is the one used', listen.restore, snap())

  let leaked = 0
  for (let t = HOLD_MS + 30; t < HOLD_MS + 600; t += 30) {
    if (!h.down(t, snap()).swallow) leaked++
  }
  check('no repeat types a space while listening', leaked, 0)
}

/* ----------------------------------------------------- the stale timer */

/**
 * The timer is a setTimeout, and a setTimeout fires whatever happened in the
 * meantime. If the key came up first, it must do nothing at all - otherwise a
 * quick space starts a recording half a second after the fact.
 */
{
  const h = new HoldToTalk()
  h.down(0, snap())
  release(h, 50)
  check('a timer that fires after the release does nothing', h.tick(HOLD_MS).kind, 'nothing')
  check('and nothing is listening', h.state, 'idle')
}
{
  const h = new HoldToTalk()
  check('a timer with no press behind it does nothing', h.tick(HOLD_MS).kind, 'nothing')
}
{
  // Two taps in quick succession, the first timer still pending.
  const h = new HoldToTalk()
  h.down(0, snap('a', 1))
  release(h, 50)
  h.down(300, snap('ab', 2))
  check('the stale timer cannot fire for the new press', h.tick(HOLD_MS).kind, 'nothing')
  check('but the new press reaches its own delay', h.tick(300 + HOLD_MS).kind, 'listen')
}

/* ------------------------------------------------------------- giving up */

{
  const h = new HoldToTalk()
  h.down(0, snap())
  h.abort()
  check('abort disarms', h.state, 'idle')
  check('and the timer then does nothing', h.tick(HOLD_MS).kind, 'nothing')
}
{
  const h = new HoldToTalk()
  h.down(0, snap())
  h.tick(HOLD_MS)
  check('aborting while listening cancels', h.abort().kind, 'cancel')
  check('and stops listening', h.state, 'idle')
}
{
  // A release the box never saw - focus moved mid-press - must not leave the
  // next space looking like the end of a hold.
  const h = new HoldToTalk()
  h.down(0, snap())
  h.tick(HOLD_MS)
  h.abort()
  check('the next space starts over', h.down(2000, snap()).kind, 'arm')
}

/* ------------------------------------- repeats that come as release + press */

/**
 * With an input method in between, a held key can reach the page as press,
 * release, press, release - a pair per repeat. Each release used to end the
 * hold and each press start a new one, so half a second was never reached.
 */
{
  const h = new HoldToTalk()
  h.down(0, snap('say ', 4))
  let restarted = 0
  let ended = 0
  for (let t = 250; t < HOLD_MS + 400; t += 25) {
    const up = h.up(t)
    if (up.kind !== 'wait') ended++
    if (h.settle(t + 2).kind !== 'nothing') ended++
    const down = h.down(t + 3, snap('WRONG', 0))
    if (down.kind === 'arm' && down.wait === HOLD_MS) restarted++
    if (t + 3 >= HOLD_MS && h.state === 'armed') {
      const listen = h.tick(t + 3)
      if (listen.kind === 'listen') {
        check('paired repeats still reach the delay', t + 3 - HOLD_MS < 30, true)
        check('with the snapshot from the first press', listen.restore, snap('say ', 4))
      }
    }
  }
  check('a pair never ends the hold', ended, 0)
  check('nor starts the half-second again', restarted, 0)
  check('and it is listening', h.state, 'listening')
  check('a real release still sends', release(h, 5000).kind, 'send')
  check('idle after', h.state, 'idle')
}
{
  // The timer can fire in the gap between a repeat's release and its press;
  // the press then has to set it going again for what is left.
  const h = new HoldToTalk()
  h.down(0, snap())
  h.up(HOLD_MS - 2)
  check('a tick inside the gap does nothing', h.tick(HOLD_MS + 16).kind, 'nothing')
  const again = h.down(HOLD_MS + 20, snap('WRONG', 0))
  check('the next press re-arms at once', [again.kind, again.wait], ['arm', 0])
  check('and listens', h.tick(HOLD_MS + 20).kind, 'listen')
}
{
  // A settle that comes early - a press may still be on its way - waits.
  const h = new HoldToTalk()
  h.down(0, snap())
  h.up(100)
  check('settle before the bridge is up does nothing', h.settle(100 + BRIDGE_MS - 1).kind, 'nothing')
  check('a tap is still a space after it', h.settle(100 + BRIDGE_MS).kind, 'cancel')
}
{
  // A settle timer late behind a busy frame: the next press finishes the old
  // recording rather than carrying on with it.
  const h = new HoldToTalk()
  h.down(0, snap())
  h.tick(HOLD_MS)
  h.up(1000)
  check('a press long after a release sends what was said', h.down(1000 + BRIDGE_MS + 500, snap()).kind, 'send')
  check('and listens no more', h.state, 'idle')
}
{
  const h = new HoldToTalk()
  h.down(0, snap())
  h.tick(HOLD_MS)
  h.up(900)
  check('let go, then focus left: it is sent, not thrown away', h.abort().kind, 'send')
}

/* ------------------------------------------------- what counts as a space */

const key = (over = {}) => ({
  key: ' ',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...over
})
check('a plain space', isPlainSpace(key()), true)
check('Ctrl+Space is a shortcut', isPlainSpace(key({ ctrlKey: true })), false)
check('Shift+Space is not a space', isPlainSpace(key({ shiftKey: true })), false)
check('Alt+Space opens the window menu', isPlainSpace(key({ altKey: true })), false)
check('and a letter is a letter', isPlainSpace(key({ key: 'a' })), false)
check('Space through an input method', isPlainSpace(key({ key: 'Process', code: 'Space' })), true)
check('or one that does not say', isPlainSpace(key({ key: 'Unidentified', code: 'Space' })), true)
check('but not picking a candidate', isPlainSpace(key({ isComposing: true })), false)
check('and Process on another key is not Space', isPlainSpace(key({ key: 'Process', code: 'KeyA' })), false)

/* ------------------------------------------------------------- the wiring */

const composer = readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
check('the composer uses the machine', /new HoldToTalk\(\)/.test(composer), true)
// The gate itself: with voice off, a space never even reaches the machine.
check(
  'and only when voice input is on',
  /dictation\.enabled && isPlainSpace\(e\)/.test(composer),
  true
)
check('the timer is cleared, not left running', /clearTimeout/.test(composer), true)
check('losing focus aborts', /onBlur/.test(composer), true)
check('a swallowed key is prevented', /action\.swallow/.test(composer), true)
check('a release waits to see if it was a repeat', /hold\.current\.settle\(/.test(composer), true)
check('and a hold that never listened is logged', /recording never started/.test(composer), true)

/**
 * "As accurate as possible" means there is no size to choose any more, so
 * nothing may offer one.
 */
const settings = readFileSync('src/shared/types.ts', 'utf8')
check('there is no voiceModel setting', /voiceModel/.test(settings), false)
const commands = readFileSync('src/renderer/src/commands.ts', 'utf8')
check('and no /speech command', /name: 'speech'/.test(commands), false)
check('but there is a /voice command', /name: 'voice'/.test(commands), true)

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} hold-to-talk checks`)
process.exit(failed === 0 ? 0 : 1)

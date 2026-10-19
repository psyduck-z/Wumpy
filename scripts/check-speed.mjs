/**
 * The speed meter, which was reporting impossible numbers.
 *
 * Run with: npm run check:speed
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.speed-check.mjs'
await build({
  entryPoints: ['src/shared/speed.ts'],
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

/* The reported bug: 8 tokens in one chunk read as 8,000 a second. */
check('a single-chunk reply reports nothing', S.tokensPerSecond(8, 0), null)
check('nor does a sub-millisecond window', S.tokensPerSecond(400, 0.4), null)
check('nor one just under the floor', S.tokensPerSecond(100, S.MIN_WINDOW_MS - 1), null)

/* An ordinary answer still reports, and reports correctly. */
check('120 tokens in 2s is 60 a second', S.tokensPerSecond(120, 2000), 60)
check('at the floor it reports', S.tokensPerSecond(60, S.MIN_WINDOW_MS), (60 / S.MIN_WINDOW_MS) * 1000)

/* One word answered instantly is not a throughput measurement. */
check('a one-token reply reports nothing', S.tokensPerSecond(1, 5000), null)
check('nor three', S.tokensPerSecond(3, 5000), null)
check('four is enough', S.tokensPerSecond(4, 1000), 4)

/* Nothing here may produce Infinity or NaN, which is what reached the UI. */
for (const [c, w] of [[0, 0], [10, 0], [0, 1000], [NaN, 100], [10, NaN], [Infinity, 1000]]) {
  const got = S.tokensPerSecond(c, w)
  if (got !== null && !Number.isFinite(got)) {
    failed++
    console.log(`FAIL tokensPerSecond(${c}, ${w}) = ${got}`)
  }
  count++
}
console.log(`ok   no input produces Infinity or NaN`)

/*
 * WAITING IS NOT THINKING, and the bar says which.
 *
 * "it thinks a bit overly slowly... idk if its slowed down because of
 * wumpy's looking at my screen process". Measured the same morning, same
 * build, same 15.4k preamble: 2.4s to the first token at 10:28 and 88s at
 * 12:05, with the output rate healthy either way. The time is the
 * provider's queue, and the look is 1.2s of it.
 *
 * The load figure was already here, but only after the turn ended, which
 * is when it has stopped being useful.
 */
{
  const bar = readFileSync('src/renderer/src/components/StatusBar.tsx', 'utf8')
  check('the bar says when nothing has arrived yet', /stats\.liveTokens === 0/.test(bar), true)
  check('and says it is the model being waited on', /waiting for the model/.test(bar), true)
  check('while the rate still waits for real tokens', /stats\.liveTokens > 0/.test(bar), true)
}

/* ------------------------------- the clock, across a whole interaction */

/*
 * A turn ends whenever Wumpy goes and does something - a screenshot, a
 * command, a picture opened - and the hand-back is a new turn with a new
 * clock. So the time under an answer was the last request of several, and
 * "1.2s" sat under something nobody waited 1.2 seconds for. Reported from
 * use, in those words: taking a picture resets the timer.
 */
{
  const chat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

  check('a task clock exists beside the turn clock', /taskMsSoFar/.test(chat), true)
  /* The one line that decides it: a hand-back continues, a typed message
     starts over. Without the guard this is just the turn clock again. */
  check(
    'only a message the user sent starts a new one',
    /if \(!automatic\) taskMsSoFar\.current = 0/.test(chat),
    true
  )

  /*
   * ACCUMULATED, NOT WALL CLOCK. A proposal waits on screen until it is
   * pressed, so timing first message to last would count how long someone
   * spent deciding - a task thought about over lunch reporting four hours
   * of work.
   */
  check('the turns are added up', /taskMsSoFar\.current \+= turnMs/.test(chat), true)
  /* Outside the state updater, which React may call twice for one event. */
  check(
    'and added up outside the updater',
    chat.indexOf('taskMsSoFar.current += turnMs') < chat.indexOf('lastTaskMs: taskMs'),
    true
  )

  /* The live bar has to follow the same clock, or it still drops to zero
     mid-task even though the final figure is right. */
  check(
    'the live bar counts the task too',
    /elapsedMs: taskMsSoFar\.current \+ \(Date\.now\(\)/.test(chat),
    true
  )

  /* Shown only when it differs, so an ordinary turn reads as it always
     did - and named when it does, because a bare larger number invites
     the suspicion that the model got slower. */
  check('the total is shown when it differs', /\$\{clockOf\(task\)\} total/.test(app), true)
  check('and the last leg beside it', /parts\.push\(`\$\{clockOf\(task\)\} total`, clockOf\(turn\)\)/.test(app), true)
  check('with a margin, so a rounding difference is not a split', /task > turn \+ 50/.test(app), true)
}

console.log(`${String.fromCharCode(10)}${count - failed}/${count} speed checks correct`)
process.exit(failed === 0 ? 0 : 1)

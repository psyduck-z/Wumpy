/**
 * Key rotation, which only earns its place if it actually multiplies the
 * rate rather than just surviving longer.
 *
 * Measured on this machine: Gemini's free tier is FIVE requests a minute on
 * gemini-3.5-flash, and one Wumpy install is four requests. Google applies
 * that per PROJECT, not per key, so five keys from five projects is five
 * times the allowance and five keys from one project is none.
 *
 * Run with: npm run check:rotation
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.rotation-check.mjs')
await build({
  entryPoints: ['src/shared/rotation.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { KeyRotation, nextPacificMidnight, splitKeys } = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(54)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const T0 = 1_700_000_000_000
const NEWLINE = String.fromCharCode(10)

/* --------------------------------------------------- spreading the load */

/**
 * Round-robin, not always-the-first.
 *
 * With a per-minute limit the order is the whole point: five keys used
 * evenly give five times the rate, five keys used in order give the same
 * rate for five times as long. Only the first of those is what was wanted.
 */
{
  const r = new KeyRotation(5)
  const picked = [0, 1, 2, 3, 4, 5, 6].map(() => r.next(T0))
  check('five keys are used in turn, then wrap', picked, [0, 1, 2, 3, 4, 0, 1])
}

/* ------------------------------------------------------- resting a key */

{
  const r = new KeyRotation(3)
  r.next(T0) // 0
  r.rest(0, T0 + 60_000, 'per-minute')
  const after = [r.next(T0), r.next(T0), r.next(T0)]
  check('a resting key is skipped', after.includes(0), false)
  check('and the others still rotate', after, [1, 2, 1])

  /**
   * It comes back by itself once the clock passes - but not necessarily as
   * the very next pick, because the cursor has moved on. Asserting the
   * index here was the test being wrong about round-robin, not the code:
   * what matters is that the key becomes usable again, not that it jumps
   * the queue.
   */
  const later = T0 + 61_000
  check('the rested key is counted as usable again', r.availableCount(later), 3)
  const sweep = [r.next(later), r.next(later), r.next(later)]
  check('and it comes round in the next full turn', sweep.includes(0), true)
}

/* ---------------------------------------------- every key spent at once */

{
  const r = new KeyRotation(2)
  r.rest(0, T0 + 30_000)
  r.rest(1, T0 + 10_000)
  check('nothing to use while all rest', r.next(T0), null)
  check('and it says how long until one frees', r.waitMs(T0), 10_000)
  check('the soonest one, not the longest', r.next(T0 + 11_000), 1)
}

/**
 * A daily exhaustion outranks a per-minute one.
 *
 * Both arrive as 429 and the daily one carries a retryDelay measured in
 * seconds, which is how a key gets hammered all day. If a short rest could
 * overwrite a long one, the longer truth would be lost the moment the next
 * error landed.
 */
{
  const r = new KeyRotation(1)
  r.rest(0, T0 + 8 * 3600_000, 'daily')
  r.rest(0, T0 + 30_000, 'per-minute')
  check('a short rest cannot shorten a long one', r.next(T0 + 60_000), null)
  check('and the long one still stands', r.waitMs(T0) > 7 * 3600_000, true)
}

/* -------------------------------------------------- keys added or taken */

{
  const r = new KeyRotation(2)
  r.rest(1, T0 + 60_000)
  r.resize(1)
  // The rest belonged to a key that no longer exists.
  check('shrinking forgets a vanished key', r.next(T0), 0)

  const g = new KeyRotation(1)
  g.rest(0, T0 + 60_000)
  g.resize(3)
  check('growing makes the new keys usable at once', g.next(T0), 1)
  check('without waking the resting one early', g.availableCount(T0), 2)
}

check('no keys means nothing to pick', new KeyRotation(0).next(T0), null)
check('and no wait to report', new KeyRotation(0).waitMs(T0), 0)

/* ------------------------------------------------- when the day resets */

/**
 * Google resets requests-per-day at midnight Pacific. It is the one reset
 * worth hardcoding, because the error body never carries it.
 */
{
  const reset = nextPacificMidnight(T0)
  check('the daily reset is in the future', reset > T0, true)
  check('and within 24 hours', reset - T0 <= 24 * 3600_000, true)
  // Whatever the offset, it should land on midnight in Los Angeles.
  const asPacific = new Date(reset).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  check('and it really is midnight there', /^(00|24):00/.test(asPacific), true)
}

/* ------------------------------------- the point of the whole exercise */

/**
 * The arithmetic that justifies five keys. At five requests a minute each,
 * five projects carry a four-request install plus change; one project does
 * not finish it.
 */
{
  const PER_KEY_RPM = 5
  const INSTALL_REQUESTS = 4
  const r = new KeyRotation(5)
  let served = 0
  for (let i = 0; i < PER_KEY_RPM * 5; i++) if (r.next(T0) !== null) served++
  check('five keys serve 25 requests a minute', served, 25)
  check('which covers an install six times over', Math.floor(served / INSTALL_REQUESTS), 6)
}

/* ------------------------------------- the paste, split into keys ------- */

/**
 * Five keys arrive as one paste. looksLikeKey refuses anything containing a
 * space, which is right for one key and wrong for five, so the splitting
 * has to happen before validation rather than after.
 *
 * KeyStore imports electron, so only its static splitter is exercised here;
 * the storage itself is covered by the app's own startup.
 */
{
  const split = splitKeys
  check('a space-separated paste is five keys', split('a b c d e').length, 5)
  check('newlines too', split('a' + NEWLINE + 'b' + NEWLINE + 'c').length, 3)
  check('and commas', split('a, b, c').length, 3)
  check('and semicolons', split('a;b').length, 2)
  check('stray whitespace is dropped', split('  a   b  '), ['a', 'b'])
  check('an empty paste is no keys', split('   ').length, 0)
  check('one key stays one key', split('AIzaOnlyOne'), ['AIzaOnlyOne'])
}

/* ------------------------------------- one bad key out of ten ------------ */

/**
 * A rejected key must not end the turn while others are untried.
 *
 * The retry loop lives inside a fetch and cannot be exercised here, so this
 * reads the source - the same way the hotkey and keyboard suites pin
 * arrangements no unit test can reach.
 *
 * Pinned because the old behaviour was right when there was one key and
 * became a bug when there were ten, silently: a revoked key meant roughly
 * every tenth question failed with "Google rejected the key" while nine
 * working keys sat idle. Observed in a benchmark run, where one 401 took
 * whole questions down with it.
 */
{
  const cloud = readFileSync('src/main/cloud.ts', 'utf8')
  const at = cloud.indexOf('res.status === 401')
  const auth = cloud.slice(at, at + 1600)
  /* `reject`, not `rest`: it was a 24-hour rest, which expired, and the day
     roll cleared it even sooner. A refusal has to outlive both. */
  check('a rejected key is set aside', /rotation\.reject\(index\)/.test(auth), true)
  check('not merely rested for a day', /rotation\.rest\(index/.test(auth), false)
  /* availableCount now takes a clock and a model, so the arguments are not
     spelled out here - only that the count gates the continue. */
  check('and the turn tries the next one', /availableCount\([\s\S]{0,40}?\) > 0\) continue/.test(auth), true)
  check('the user is told which key it was', /keys\.hint\(provider, index\)/.test(auth), true)
  check(
    'the error only speaks when nothing is left',
    auth.indexOf('availableCount(') >= 0 &&
      auth.indexOf('availableCount(') < auth.indexOf('handlers.onError'),
    true
  )
}

/* ------------------------------------ the restart that killed three projects */

/*
 * Round-robin walked an in-memory cursor that started at zero on every
 * launch, and `npm run restart` is Stop-Process -Force. A short session is a
 * handful of requests, so key one served the first of them EVERY TIME, key
 * two the second, and the back of the list saw traffic only in sessions long
 * enough to wrap around.
 *
 * Google then restricted three projects for heavy free-tier use. They were
 * Wumpy1, Wumpy2 and Wumpy3 - positions one, two and three, the only three
 * that have ever returned 401 in this machine's logs.
 *
 * So: twenty short sessions of five requests each, with a restart between
 * every one, which is an ordinary week here. The ledger is what carries
 * across, exactly as it does on disk.
 */
{
  const KEYS = 17
  const SESSIONS = 20
  const PER_SESSION = 5
  let saved = null
  let at = T0
  for (let s = 0; s < SESSIONS; s++) {
    /* A new KeyRotation is a new launch: the cursor is back at zero and the
       only thing it knows is the ledger it is handed. */
    const r = new KeyRotation(KEYS, saved, at)
    for (let i = 0; i < PER_SESSION; i++) {
      r.next(at, 'gemini-3.5-flash')
      at += 20_000
    }
    saved = r.snapshot(at)
  }
  const used = saved.spend.map((s) => s.models['gemini-3.5-flash'] ?? 0)
  const total = used.reduce((a, b) => a + b, 0)
  check('every request is accounted for', total, SESSIONS * PER_SESSION)
  /* 100 requests over 17 keys is 5.88 each, so 5 or 6 everywhere. */
  check('the busiest key and the quietest differ by one', Math.max(...used) - Math.min(...used), 1)
  check('no key is left unused', used.filter((n) => n === 0).length, 0)
  /* The old behaviour, stated so the regression is unmistakable: with a
     cursor that resets, the first five keys take all one hundred. */
  check('the front of the list is not hammered', used[0] <= 6, true)
  check('and the back of it is not idle', used[KEYS - 1] >= 5, true)
}

/* A long single session should still spread, which the cursor already did. */
{
  const r = new KeyRotation(5, null, T0)
  let at = T0
  for (let i = 0; i < 20; i++) {
    r.next(at, 'm')
    at += 20_000
  }
  check('an even spread within one session', r.snapshot(at).spend.map((s) => s.models.m), [4, 4, 4, 4, 4])
}

/* A key added mid-day is behind on count, and catching it up must not mean
   handing it everything at once: the limit being avoided is per minute. */
{
  const r = new KeyRotation(3, null, T0)
  let at = T0
  for (let i = 0; i < 9; i++) {
    r.next(at, 'm')
    at += 60_000
  }
  r.resize(4, at)
  const picks = []
  for (let i = 0; i < 4; i++) {
    picks.push(r.next(at, 'm'))
    at += 1000
  }
  check('a new key catches up', picks[0], 3)
  check('but not all at once', picks.filter((p) => p === 3).length <= 3, true)
  check('and the others still get a turn', new Set(picks).size > 1, true)
}

/* Resting still beats being least-used: a key that cannot answer is not a
   candidate however little it has done. */
{
  const r = new KeyRotation(3, null, T0)
  r.rest(0, T0 + 60_000, 'rate limited')
  const picks = [r.next(T0, 'm'), r.next(T0, 'm'), r.next(T0, 'm')]
  check('a resting key is never the least-used choice', picks.includes(0), false)
  check('and the others share it', picks.filter((p) => p === 1).length, 2)
}

/* Time is the last word between two equally-used keys, so a burst does not
   land twice on the same project. */
{
  const r = new KeyRotation(2, null, T0)
  check('the first goes somewhere', r.next(T0, 'm'), 0)
  check('and the second goes elsewhere', r.next(T0 + 100, 'm'), 1)
  check('then back again', r.next(T0 + 200, 'm'), 0)
}

console.log(`\n${count - failed}/${count} rotation checks correct`)
process.exit(failed === 0 ? 0 : 1)

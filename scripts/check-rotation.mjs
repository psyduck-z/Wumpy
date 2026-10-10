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
import { rmSync } from 'node:fs'
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

console.log(`\n${count - failed}/${count} rotation checks correct`)
process.exit(failed === 0 ? 0 : 1)

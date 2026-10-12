/**
 * How much free quota is left, which was being answered wrongly in four
 * separate ways.
 *
 * Asked for as "make it easier to navigate the quota, make it more accurate".
 * The four:
 *
 *   1. The measured cap was the POOL's request count at the moment one key
 *      died, and was then multiplied by the number of keys. With twenty keys
 *      a real 25-a-day was recorded as ~500 and shown as 10,000, so the meter
 *      read a couple of percent all the way into the wall.
 *   2. A daily exhaustion rested the whole KEY, although Google's allowance is
 *      per model as well as per project. One model running out retired a key
 *      that still had its full allowance on the other two.
 *   3. The counters rolled over at LOCAL midnight; Google resets at midnight
 *      Pacific. From here that is eight hours early - a late session saw 0%
 *      with every key spent.
 *   4. The rests were forgotten on restart, so every dead key was rediscovered
 *      with a 429, which is itself a request. Wumpy restarts several times an
 *      hour while it is being worked on.
 *
 * Run with: npm run check:quota
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

async function load(entry, tag) {
  const out = `.quota-check-${tag}.mjs`
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const P = await load('src/shared/pool.ts', 'pool')
const R = await load('src/shared/rotation.ts', 'rot')
const U = await load('src/shared/usage.ts', 'use')
const Q = await load('src/renderer/src/quota.ts', 'view')

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  const shown = JSON.stringify(got)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${shown?.length > 46 ? `${shown.slice(0, 46)}…` : shown}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/* A fixed moment, so nothing here depends on when it is run. */
const NOW = 1_760_000_000_000
const MIDNIGHT = NOW + 7 * HOUR + 12 * MINUTE

const FLASH = 'gemini-3.8-flash'
const LITE = 'gemini-3.1-flash-lite'

/* ------------------------------------------------- the cap is per project */

/*
 * The headline bug. One key said it was out after 25 requests; the pool had
 * made 500 by then because twenty keys were rotating.
 */
{
  let day = { date: 'd', quotaDay: 'q', models: {} }
  for (let i = 0; i < 500; i++) day = U.record(day, { model: FLASH, via: 'google' })
  const withKey = U.record(day, {
    model: FLASH,
    via: 'google',
    error: true,
    exhausted: true,
    exhaustedAfter: 25
  })
  check('the measured cap is what ONE key spent', U.summarise(withKey)[0].exhaustedAt, 25)
  check('not the pool total', U.summarise(withKey)[0].exhaustedAt === 500, false)

  /* And the ceiling it implies, across twenty keys. */
  check('twenty keys of 25 is 500, not 10,000', U.perKeyCapFor(withKey, FLASH) * 20, 500)

  /* Without the per-key figure it still falls back, which is right for one key. */
  const oneKey = U.record(day, { model: FLASH, via: 'google', error: true, exhausted: true })
  check('one key and no figure falls back to the total', U.summarise(oneKey)[0].exhaustedAt, 500)
}

/* ---------------------------------------- a measurement beats the table */

{
  const blank = { date: 'd', quotaDay: 'q', models: {} }
  check('with nothing measured the table is used', U.perKeyCapFor(blank, FLASH), 25)
  check('an unknown model has no cap at all', U.perKeyCapFor(blank, 'gemini-9-new'), 0)

  let seen = blank
  seen = U.record(seen, { model: FLASH, via: 'google' })
  seen = U.record(seen, { model: FLASH, via: 'google', exhausted: true, exhaustedAfter: 7 })
  check('what this machine saw overrides it', U.perKeyCapFor(seen, FLASH), 7)
}

/* -------------------------------------- a daily cap is per model per key */

/*
 * Resting the whole key threw away quota that existed: with three Gemini
 * models on one key, running out of one retired all three.
 */
{
  let pool = P.emptyPool('2026-10-12', 3)
  pool = P.outOn(pool, 0, FLASH, MIDNIGHT)
  check('the key is out of the model that ran out', P.isReady(pool.spend[0], FLASH, NOW), false)
  check('and still ready for the others', P.isReady(pool.spend[0], LITE, NOW), true)
  check('so two keys can answer that model', P.readyCount(pool, FLASH, NOW), 2)
  check('and all three can answer the other', P.readyCount(pool, LITE, NOW), 3)

  /* A per-minute throttle is different: it holds the project, so the key. */
  let held = P.emptyPool('2026-10-12', 3)
  held = P.restOn(held, 1, NOW + 20_000, 'per-minute')
  check('a throttle holds the whole key', P.isReady(held.spend[1], LITE, NOW), false)
  check('but only for as long as it says', P.isReady(held.spend[1], LITE, NOW + 21_000), true)
}

/* ------------------------------------------------- never shorten a rest */

{
  let pool = P.emptyPool('2026-10-12', 1)
  pool = P.outOn(pool, 0, FLASH, MIDNIGHT)
  pool = P.outOn(pool, 0, FLASH, NOW + 30_000)
  check('a 30-second retryDelay cannot undo a daily cap', pool.spend[0].outOf[FLASH], MIDNIGHT)

  let rested = P.emptyPool('2026-10-12', 1)
  rested = P.restOn(rested, 0, NOW + 8 * HOUR, 'rejected')
  rested = P.restOn(rested, 0, NOW + 1000, 'per-minute')
  check('and the same for a rejected key', rested.spend[0].restUntil, NOW + 8 * HOUR)
}

/* ------------------------------------------------------ counting spends */

{
  let pool = P.emptyPool('2026-10-12', 2)
  pool = P.spendOn(pool, 0, FLASH)
  pool = P.spendOn(pool, 0, FLASH)
  pool = P.spendOn(pool, 0, LITE)
  pool = P.spendOn(pool, 1, FLASH)
  check('requests are counted per key and per model', P.requestsOn(pool, 0, FLASH), 2)
  check('a different model on the same key is separate', P.requestsOn(pool, 0, LITE), 1)
  check('and the pool total adds up', P.requestsFor(pool, FLASH), 3)
  check('spending on a key that is not there changes nothing', P.spendOn(pool, 9, FLASH), pool)
}

/* -------------------------------------------- what is actually remaining */

/*
 * The number worth acting on. Keys that are out for the day have nothing
 * left to give and must not be counted; keys catching their breath for
 * twenty seconds have lost nothing and must be.
 */
{
  let pool = P.emptyPool('2026-10-12', 20)
  for (let i = 0; i < 25; i++) pool = P.spendOn(pool, 3, FLASH)
  pool = P.outOn(pool, 3, FLASH, MIDNIGHT)
  pool = P.restOn(pool, 7, NOW + 20_000, 'per-minute')
  pool = P.spendOn(pool, 7, FLASH)

  const view = P.poolView(pool, FLASH, 25, NOW, MIDNIGHT)
  check('one key is out for the day', view.spent, 1)
  check('one is resting a moment', view.resting, 1)
  check('eighteen can answer right now', view.ready, 18)
  check('the ceiling is the per-key cap times the keys', view.cap, 500)
  check('the dead key takes its 25 with it', view.remaining, 500 - 25 - 1)
  check('and the resting key keeps its allowance', view.remaining > 450, true)
  check('the fraction counts the dead key as spent', Math.round(view.usedFraction * 100), 5)
  check('something is usable, so nothing to wait for', view.nextFreeMs, 0)
  check('the reset is carried through for the report', view.resetAt, MIDNIGHT)
  check('26 requests went out today', view.requests, 26)
}

/* No credible cap: say so rather than show a full or empty meter. */
{
  let pool = P.emptyPool('2026-10-12', 5)
  pool = P.spendOn(pool, 0, 'gemini-9-new')
  const view = P.poolView(pool, 'gemini-9-new', 0, NOW, MIDNIGHT)
  check('an unknown cap leaves remaining unknown', view.remaining, null)
  check('and the fraction too', view.usedFraction, null)
  check('while the requests are still counted', view.requests, 1)
}

/* Every key out: how long until anything works. */
{
  let pool = P.emptyPool('2026-10-12', 3)
  pool = P.outOn(pool, 0, FLASH, MIDNIGHT)
  pool = P.outOn(pool, 1, FLASH, MIDNIGHT)
  pool = P.restOn(pool, 2, NOW + 45_000, 'per-minute')
  check('nothing is ready', P.readyCount(pool, FLASH, NOW), 0)
  check('and the soonest is the throttled one', P.nextFreeMs(pool, FLASH, NOW), 45_000)
  check('once it passes, it is usable again', P.readyCount(pool, FLASH, NOW + 46_000), 1)
}

/* -------------------------------------------------- the day that rolls */

/*
 * Pacific, not local. The whole point: at 00:30 here it is still yesterday
 * afternoon in California and nothing has reset.
 */
{
  const key = P.pacificDayKey(NOW)
  check('the quota day is an ISO date', /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(key), true)
  check('and it is the Pacific one', key, new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }))

  /* 01:00 UTC on the 9th is 17:00 Pacific on the 8th. */
  const utcEarly = Date.parse('2026-04-09T01:00:00Z')
  check('an hour after UTC midnight is still yesterday there', P.pacificDayKey(utcEarly), '2026-04-08')

  const reset = P.nextPacificMidnight(NOW)
  check('the reset is in the future', reset > NOW, true)
  check('and within a day', reset - NOW <= 24 * HOUR, true)
}

{
  let pool = P.emptyPool('2026-10-11', 4)
  pool = P.spendOn(pool, 0, FLASH)
  pool = P.outOn(pool, 1, FLASH, MIDNIGHT)
  const rolled = P.rollPool(pool, '2026-10-12', 4)
  check('a new quota day forgets everything', rolled.spend[0].models, {})
  check('including the keys that were out', P.readyCount(rolled, FLASH, NOW), 4)

  /*
   * And it only ever rolls FORWARD. An earlier day arriving is a clock that
   * went backwards or a timestamp from somewhere else, and wiping on one of
   * those is how eight keys came back from the dead and got hammered.
   */
  const backwards = P.rollPool(pool, '2026-10-10', 4)
  check('an earlier day changes nothing', backwards.spend[1].outOf[FLASH], MIDNIGHT)
}

/* ------------------------------------------------- keys added and taken */

{
  let pool = P.emptyPool('2026-10-12', 2)
  pool = P.spendOn(pool, 0, FLASH)
  pool = P.outOn(pool, 1, FLASH, MIDNIGHT)

  const grown = P.rollPool(pool, '2026-10-12', 5)
  check('ten more keys keep what the old ones spent', P.requestsOn(grown, 0, FLASH), 1)
  check('and keep the ones that were out, out', P.isReady(grown.spend[1], FLASH, NOW), false)
  check('while the new ones are ready', P.readyCount(grown, FLASH, NOW), 4)

  /* Shrinking is a replaced list, so no index means what it did. */
  const shrunk = P.rollPool(pool, '2026-10-12', 1)
  check('a replaced list starts clean', P.requestsOn(shrunk, 0, FLASH), 0)
  check('with the right number of slots', shrunk.spend.length, 1)
}

/* ------------------------------------------- the rotation over the pool */

{
  const r = new R.KeyRotation(3, null, NOW)
  check('it hands out keys in turn', [r.next(NOW, FLASH), r.next(NOW, FLASH), r.next(NOW, FLASH)], [0, 1, 2])
  check('and counts what it handed out', r.requests(0, FLASH, NOW), 1)

  r.out(1, FLASH, MIDNIGHT)
  const after = [r.next(NOW, FLASH), r.next(NOW, FLASH), r.next(NOW, FLASH)]
  check('the key that is out is skipped for that model', after.includes(1), false)
  check('but not for another one', r.next(NOW, LITE) !== null, true)

  /* The whole reason for persisting: a restart must not forget this. */
  const saved = r.snapshot(NOW)
  const reborn = new R.KeyRotation(3, saved, NOW)
  check('a restart remembers the key that is out', reborn.availableCount(NOW, FLASH), 2)
  check('and what the others had spent', reborn.requests(0, FLASH, NOW) > 0, true)

  /* A saved ledger from yesterday is not carried over. */
  const stale = new R.KeyRotation(3, { ...saved, day: '2001-01-01' }, NOW)
  check('yesterday is not carried over', stale.availableCount(NOW, FLASH), 3)
}

{
  /* The view the status bar reads, straight off the rotation. */
  const r = new R.KeyRotation(4, null, NOW)
  r.next(NOW, FLASH)
  r.out(2, FLASH, MIDNIGHT)
  const view = r.view(FLASH, 25, MIDNIGHT, NOW)
  check('the view names the model it counted', view.model, FLASH)
  check('three of four keys are ready', view.ready, 3)
  check('one request has gone out', view.requests, 1)
  check('and one key has a row saying it is out', view.rows.filter((x) => x.state === 'out').length, 1)
  check('rows are numbered from one, like the log lines', view.rows[0].number, 1)
}

/* ------------------------------------------------------- what it reads like */

{
  let pool = P.emptyPool('2026-10-12', 20)
  for (let i = 0; i < 25; i++) pool = P.spendOn(pool, 3, FLASH)
  pool = P.outOn(pool, 3, FLASH, MIDNIGHT)
  pool = P.restOn(pool, 6, NOW + 40_000, 'per-minute')
  const text = Q.poolLines(P.poolView(pool, FLASH, 25, NOW, MIDNIGHT), NOW).join(NL)

  /* 18, not 19: the dead key and the throttled one are both unavailable. */
  check('it leads with how many keys can answer', text.includes('18 of 20 keys ready'), true)
  /* 475: the dead key's whole 25 is gone, the throttled key's is not. */
  check('it gives a number to act on', text.includes('**475**'), true)
  check('it shows the arithmetic', text.includes('25 per key x 20'), true)
  check('it names the key that is out', /Out until the reset: key 4/.test(text), true)
  check('and when it comes back, in hours', /in 7h 12m/.test(text), true)
  check('the throttled key is told apart from the dead one', /Catching breath: key 7/.test(text), true)
  check('and there is a table of the busy ones', text.includes('| 4 | 25 / 25 | out for the day |'), true)
  check('with the quiet nineteen left out', text.includes('| 20 |'), false)
}

{
  /* The happy case says so in one line rather than listing twenty keys. */
  const pool = P.emptyPool('2026-10-12', 20)
  const text = Q.poolLines(P.poolView(pool, FLASH, 25, NOW, MIDNIGHT), NOW).join(NL)
  check('a fresh pool says every key can answer', text.includes('Every key can answer'), true)
  check('and still gives the ceiling', text.includes('500 requests'), true)
  check('with no table, because nothing has happened', text.includes('| key |'), false)
}

{
  /* Nothing left: the one case where the wording has to be unmissable. */
  let pool = P.emptyPool('2026-10-12', 2)
  pool = P.outOn(pool, 0, FLASH, MIDNIGHT)
  pool = P.outOn(pool, 1, FLASH, MIDNIGHT)
  const text = Q.poolLines(P.poolView(pool, FLASH, 25, NOW, MIDNIGHT), NOW).join(NL)
  check('it says nothing can answer', text.includes('**Nothing can answer right now**'), true)
  check('and it says when that changes', text.includes('in 7h 12m'), true)
  check('nothing remains', /About \*\*0\*\*/.test(text), true)
}

{
  /* No cap known: say that, rather than imply a full meter. */
  const pool = P.spendOn(P.emptyPool('2026-10-12', 3), 0, 'gemini-9-new')
  const text = Q.poolLines(P.poolView(pool, 'gemini-9-new', 0, NOW, MIDNIGHT), NOW).join(NL)
  check('an unknown cap is admitted', text.includes('No daily cap worth trusting'), true)
  check('and says how it will be learned', text.includes('becomes the cap'), true)
  check('an empty pool prints nothing at all', Q.poolLines(P.poolView(P.emptyPool('d', 0), FLASH, 25, NOW, MIDNIGHT), NOW), [])
}

/* ------------------------------------------------------- the small words */

check('one key is "4"', Q.keyList([4]), '4')
check('two are joined with and', Q.keyList([4, 11]), '4 and 11')
check('three are a list', Q.keyList([4, 11, 19]), '4, 11 and 19')
check('none is nothing', Q.keyList([]), '')

check('seconds stay seconds', Q.untilText(45_000), 'in 45s')
check('a minute and a half becomes minutes', Q.untilText(95_000), 'in 2 min')
check('hours become hours and minutes', Q.untilText(7 * HOUR + 12 * MINUTE), 'in 7h 12m')
check('a whole number of hours drops the minutes', Q.untilText(3 * HOUR), 'in 3h')
check('a negative wait is now', Q.untilText(-5000), 'in 0s')

/* ---------------------------------------------------------- the wiring */

const cloud = readFileSync('src/main/cloud.ts', 'utf8')
check('a key is chosen for the model being asked', /rotation\.next\(Date\.now\(\), model\)/.test(cloud), true)
check('a daily cap takes out one model', /rotation\.out\(index, model, nextPacificMidnight\(\)\)/.test(cloud), true)
check('a throttle still holds the key', /rotation\.rest\(index, Date\.now\(\) \+ Math\.max/.test(cloud), true)
check('the per-key count is read before the rest', cloud.indexOf('const spentHere') < cloud.indexOf('rotation.out(index'), true)
check('and travels with the failure', /afterRequests: spentHere/.test(cloud), true)
check('the model being spent is stated, not spelled', /spent: true/.test(cloud), true)
check('the ledger is written after a request', /this\.remember\(provider, rotation\)/.test(cloud), true)
check('availability is asked per model', /availableCount\(Date\.now\(\), model\)/.test(cloud), true)
check('a wait is said in units people use', /friendlyWait\(wait\)/.test(cloud), true)

const main = readFileSync('src/main/index.ts', 'utf8')
check('the pool ledger is given to the client', /new CloudClient\(keys, pools\)/.test(main), true)
check('the report carries the pool', /pool: cloud\.poolFor\(model, cap\)/.test(main), true)
check('with the cap this machine measured', /perKeyCapFor\(usage\.today\(\)/.test(main), true)
check('a spent model is recognised by the flag', /failure\.spent === true/.test(main), true)
check('and the per-key count is recorded', /exhaustedAfter: failure\?\.afterRequests/.test(main), true)

const store = readFileSync('src/main/usage.ts', 'utf8')
check('the counters roll on the quota day', /this\.day\.quotaDay !== pacificDayKey\(\)/.test(store), true)
check('and keep counting past local midnight', /keep the counts/.test(store), true)

const ledger = readFileSync('src/main/pool.ts', 'utf8')
check('the ledger holds no key material', /secret|decryptString|Authorization/.test(ledger), false)
check('and says so where someone would look', /NO KEY MATERIAL/.test(ledger), true)
check('a corrupt file cannot become an eternal rest', /Number\(s\?\.restUntil\) \|\| 0/.test(ledger), true)

const bar = readFileSync('src/renderer/src/components/StatusBar.tsx', 'utf8')
check('the status bar shows the quota', /<QuotaMeter pool=\{pool\}/.test(bar), true)
check('and clicking it prints the breakdown', /onReport=\{onQuota\}/.test(bar), true)
check('it names no key', /maskKey|secret/.test(bar), false)

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the panel keeps the pool fresh', /window\.wumpy\.usage\.get\(\)\.then/.test(app), true)
check('without polling', /setInterval[^\n]*usage/.test(app), false)
check('the report includes the pool', /poolLines\(report\.pool\)/.test(app), true)
check('and prints it even on a quiet day', app.indexOf('const poolReport') < app.indexOf('!report.lines.length'), true)

console.log(`${NL}${count - failed}/${count} quota checks passed`)
if (failed) process.exit(1)

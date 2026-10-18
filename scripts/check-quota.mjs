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
const C = await load('src/shared/cloud.ts', 'cloud')

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
  /* The provider is passed, not defaulted. perKeyCapFor used to assume
     'google' and these checks leaned on that; the assumption is gone. */
  check('twenty keys of 25 is 500, not 10,000', U.perKeyCapFor(withKey, FLASH, 'google') * 20, 500)

  /* Without the per-key figure it still falls back, which is right for one key. */
  const oneKey = U.record(day, { model: FLASH, via: 'google', error: true, exhausted: true })
  check('one key and no figure falls back to the total', U.summarise(oneKey)[0].exhaustedAt, 500)
}

/* ---------------------------------------- a measurement beats the table */

{
  const blank = { date: 'd', quotaDay: 'q', models: {} }
  check('with nothing measured the table is used', U.perKeyCapFor(blank, FLASH, 'google'), 25)
  check('an unknown model has no cap at all', U.perKeyCapFor(blank, 'gemini-9-new', 'google'), 0)

  let seen = blank
  seen = U.record(seen, { model: FLASH, via: 'google' })
  seen = U.record(seen, { model: FLASH, via: 'google', exhausted: true, exhaustedAfter: 7 })
  check('what this machine saw overrides it', U.perKeyCapFor(seen, FLASH, 'google'), 7)

  /*
   * The MEASUREMENT is keyed by provider and model both; the TABLE is keyed
   * by model alone. So naming the wrong provider does not invent a figure -
   * it loses the measured one and falls back to the published row for that
   * same model, 7 becoming 25 here. Which is why every caller passes the
   * provider the model actually routes to rather than leaning on a default.
   */
  check('the wrong provider loses the measurement', U.perKeyCapFor(seen, FLASH, 'nvidia'), 25)
  check('and reads no measurement with none at all', U.perKeyCapFor(seen, FLASH, ''), 25)
}

/* ------------------------------ a second key is not always a second budget */

/*
 * The meter multiplied the cap by the number of keys unconditionally, which
 * is right for Google and wrong for everyone else. A Google key is a Cloud
 * project and the meters are keyed PerProjectPerModel; an NVIDIA key is a
 * credential against an account, and NVIDIA's own forum describes the limit
 * as following "the amount of current overall traffic using the same
 * access". Five keys from one login are five doors into one allowance.
 *
 * It was latent while NVIDIA had no known cap - zero multiplied is zero -
 * but the first 429 recorded from a real turn sets `exhaustedAt`, and that
 * WOULD have been multiplied. The meter would then have read half full on
 * an allowance already spent, which is the failure this whole file exists
 * to prevent, arrived at from the other direction.
 */
{
  check('Google keys each carry an allowance', C.PROVIDERS.google.quotaPerKey, true)
  for (const id of ['nvidia', 'groq', 'mistral', 'ollama']) {
    check(`${id} keys share one`, C.PROVIDERS[id].quotaPerKey ?? false, false)
  }

  check('so three Google keys are three budgets', C.budgetsFor('google', 3), 3)
  check('and three NVIDIA keys are one', C.budgetsFor('nvidia', 3), 1)
  /* Zero keys is no provider configured, not a zero allowance: a zero here
     divides a meter by nothing. */
  check('no keys still counts as one budget', C.budgetsFor('nvidia', 0), 1)
  check('and an unroutable model has one', C.budgetsFor(null, 9), 1)

  /* The same divergence through the pool, which draws the status-bar meter. */
  let shared = P.emptyPool('2026-10-18', 3)
  for (let i = 0; i < 10; i++) shared = P.spendOn(shared, i % 3, 'a/model')

  const perKey = P.poolView(shared, 'a/model', 25, NOW, MIDNIGHT, true)
  check('per key, three keys of 25 is 75', perKey.cap, 75)
  check('with 65 left after ten requests', perKey.remaining, 65)

  const pooled = P.poolView(shared, 'a/model', 25, NOW, MIDNIGHT, false)
  check('shared, three keys of 25 is still 25', pooled.cap, 25)
  /* The whole pool drank from one pot, so it is the cap less the pool's
     total - not the sum of each key's remainder, which would say 65. */
  check('and 15 left, not 65', pooled.remaining, 15)
  check('the view says which kind it is', pooled.perKeyQuota, false)

  /* A refused key costs a way in, not a slice of the budget. */
  const hurt = P.poolView(P.rejectOn(shared, 0), 'a/model', 25, NOW, MIDNIGHT, false)
  check('a dead key does not shrink a shared ceiling', hurt.cap, 25)
  const hurtPerKey = P.poolView(P.rejectOn(shared, 0), 'a/model', 25, NOW, MIDNIGHT, true)
  check('but it does shrink a per-key one', hurtPerKey.cap, 50)

  /* The pacer divides the same way, and is checked where that rule's
     history lives: see "the gap is divided the way the allowance is" in
     check-cloud.mjs. */

  /* The report has to say which, because the figures alone cannot. */
  const sharedText = Q.poolLines(pooled, NOW).join(NL)
  check('and the report says shared', /shared across all 3 keys/.test(sharedText), true)
  check('not per key', /per key x/.test(sharedText), false)
  const perKeyText = Q.poolLines(perKey, NOW).join(NL)
  check('while a per-key pool still multiplies out loud', /25 per key x 3/.test(perKeyText), true)
}

/* ------------------------------------------- the provider-level fallback */

/*
 * After the move off Google, `/usage` printed a blank note beside the model
 * in use on nearly every turn, because ALLOWANCES is keyed by model id and
 * had no NVIDIA rows. The fallback says what is true of the tier instead.
 */
{
  const DEFAULT = 'deepseek-ai/deepseek-v4.1-flash'
  const line = U.summarise(U.record({ date: 'd', models: {} }, { model: DEFAULT, via: 'nvidia' }))[0]
  check('the default model has something to say about its cap', line.note.length > 0, true)
  check('and it says no figure is published', /no daily figure published/.test(line.note), true)

  /* Nothing credible is known, so nothing is drawn. A zero cap multiplied by
     twenty keys is still zero, and must not read as a full meter. */
  check('with no figure there is no meter', line.usedFraction, null)
  check('and no cap to multiply', U.perKeyCapFor({ date: 'd', models: {} }, DEFAULT, 'nvidia'), 0)

  /* A model row still beats the provider row: a measurement on one model is
     not a fact about its neighbours. */
  check('a measured model keeps its own figure', U.allowanceFor(FLASH, 'google').requestsPerDay, 25)
  check('an unknown provider has no fallback', U.allowanceFor('who/what', 'mistral'), undefined)
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

/* ------------------------------------------- what a new day does NOT clear */

/**
 * A refusal is not a quota.
 *
 * Measured, from this machine's own pool.json on 14 October: keys 1, 2 and 3
 * refused at 16:14 the previous day, and at 15:26 the next - twenty-six
 * minutes after midnight Pacific - all twenty read ready, because the roll
 * had thrown the whole ledger away. Two costs, and the second is the nastier
 * one:
 *
 *   the meter measured the day against twenty keys' allowance when
 *   seventeen existed, which is the figure the user is shown;
 *
 *   and chooseKey ranks by fewest requests FIRST, so three keys sitting at
 *   zero were the three most attractive in the pool. Every morning the
 *   rotation went straight for the dead ones.
 *
 * Google restricted those projects. Midnight does not unrestrict them.
 */
{
  let pool = P.emptyPool('2026-10-13', 20)
  for (const i of [0, 1, 2]) pool = P.rejectOn(pool, i)
  pool = P.spendOn(pool, 5, FLASH)
  pool = P.restOn(pool, 6, NOW + 30_000, 'per-minute')
  pool = P.outOn(pool, 7, FLASH, MIDNIGHT)

  const rolled = P.rollPool(pool, '2026-10-14', 20)
  check('a new day keeps the refusals', P.rejectedCount(rolled), 3)
  check('and they still cannot be chosen', P.isReady(rolled.spend[0], FLASH, NOW), false)
  check('while the counts start again', P.requestsOn(rolled, 5, FLASH), 0)
  check('and a throttle is over', P.isReady(rolled.spend[6], FLASH, NOW), true)
  check('and so is a daily cap', P.isReady(rolled.spend[7], FLASH, NOW), true)
  check('seventeen can answer, not twenty', P.readyCount(rolled, FLASH, NOW), 17)
  /* The number the user is actually shown. */
  const view = P.poolView(rolled, FLASH, 25, NOW, MIDNIGHT)
  check('the ceiling is still seventeen keys wide', view.cap, 425)
  check('and the refusal is still reported', view.rejected, 3)

  /* The ranking bug, directly: zero requests must not make a dead key the
     most attractive one in the pool. */
  check('and the rotation does not reach for them', P.chooseKey(rolled, FLASH, NOW, 0), 3)

  /* A key added since yesterday is new, and nothing carries onto it. */
  const grown = P.rollPool(pool, '2026-10-14', 21)
  check('a key added overnight is not born refused', P.isReady(grown.spend[20], FLASH, NOW), true)
  check('and the old refusals are still there', P.rejectedCount(grown), 3)

  /*
   * But a SHORTER list carries nothing, which is the hazard in carrying
   * anything by position at all. keys.bin is written the moment /key drop
   * runs; the ledger flush can still be in its four-second timer when
   * Stop-Process -Force arrives. Launch the next day with seventeen keys
   * against a twenty-key ledger and position 0 is no longer the same key -
   * so carrying would retire the old keys 4, 5 and 6, three working
   * projects, by the mechanism meant to retire dead ones.
   */
  const shrunk = P.rollPool(pool, '2026-10-14', 17)
  check('a shorter list carries nothing', P.rejectedCount(shrunk), 0)
  check('so no working key inherits a refusal', P.readyCount(shrunk, FLASH, NOW), 17)
  check('and the day is the new one', shrunk.day, '2026-10-14')
}

/*
 * The way back out, which is what makes a sticky flag safe to have: a 401
 * is not always permanent - billing that has not propagated, a project
 * suspended and restored - and the user must not have to retype twenty keys
 * to find out. `/key <provider> check` asks the provider with a models
 * listing, which costs nothing from the day's allowance.
 */
{
  let pool = P.emptyPool('2026-10-14', 3)
  pool = P.rejectOn(pool, 1)
  check('refused', P.isReady(pool.spend[1], FLASH, NOW), false)
  pool = P.reviveOn(pool, 1)
  check('and taken back when it authenticates', P.isReady(pool.spend[1], FLASH, NOW), true)
  check('with nothing left behind', P.rejectedCount(pool), 0)

  /* Ledgers on disk right now hold the old form: a 24-hour rest whose
     reason was 'rejected'. It has to read as refused - expired or not,
     since it expiring is the bug - and revive has to clear it. */
  let legacy = P.emptyPool('2026-10-14', 3)
  legacy = P.restOn(legacy, 0, NOW - HOUR, P.REJECTED)
  check('an expired old-style refusal still counts', P.rejectedCount(legacy), 1)
  check('and cannot be chosen', P.isReady(legacy.spend[0], FLASH, NOW), false)
  check('and survives the roll as the new form', P.rollPool(legacy, '2026-10-15', 3).spend[0].rejected, true)
  legacy = P.reviveOn(legacy, 0)
  check('and the free check clears it too', P.isReady(legacy.spend[0], FLASH, NOW), true)
  check('rest and all', legacy.spend[0].restUntil, 0)
}

/*
 * A refused key has no "back at". Offering its rest as the soonest is how
 * "nothing can answer, the soonest is back in 2h" came to mean never.
 */
{
  let pool = P.emptyPool('2026-10-14', 2)
  pool = P.rejectOn(pool, 0)
  pool = P.restOn(pool, 1, NOW + 5 * 60_000, 'per-minute')
  check('the wait skips the refused key', P.nextFreeMs(pool, FLASH, NOW), 5 * 60_000)
  let both = P.emptyPool('2026-10-14', 2)
  both = P.rejectOn(both, 0)
  both = P.rejectOn(both, 1)
  check('and a wholly refused pool has no wait at all', P.nextFreeMs(both, FLASH, NOW), 0)
  check('nor anything to choose', P.chooseKey(both, FLASH, NOW, 0), null)
}

/*
 * The ledger is written at once for a rest, because the next thing to happen
 * to this process is usually Stop-Process -Force. A refusal is the most
 * expensive fact in the file to rediscover, so it has to be in that set.
 */
{
  const before = P.emptyPool('2026-10-14', 3)
  check('a refusal is written immediately', P.restsChanged(before, P.rejectOn(before, 0)), true)
  check('and so is taking it back', P.restsChanged(P.rejectOn(before, 0), before), true)
  check('a plain request still waits for the debounce', P.restsChanged(before, P.spendOn(before, 0, FLASH)), false)
  check('and a first ledger with a refusal is urgent', P.restsChanged(null, P.rejectOn(before, 0)), true)
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

/* ------------------------------------------------- the key that is simply dead */

/*
 * Measured on this machine: three of twenty keys answer 401 "the bound
 * service account is deleted or disabled". They had been in the rotation for
 * weeks. Two separate costs, both silent:
 *
 *   the meter counted a ceiling of 500 requests on a pool that could serve
 *   425, because a dead key's allowance was counted like anyone else's;
 *
 *   and roughly one turn in seven paid a request to rediscover one, since
 *   the only way the app found out was by trying to answer with it.
 */
{
  let pool = P.emptyPool('2026-10-12', 20)
  for (const i of [0, 1, 2]) pool = P.restOn(pool, i, NOW + 24 * HOUR, P.REJECTED)
  const view = P.poolView(pool, FLASH, 25, NOW, MIDNIGHT)
  check('a refused key is not merely resting', view.rejected, 3)
  check('it is not counted as resting', view.resting, 0)
  check('nor as out for the day', view.spent, 0)
  check('seventeen keys can answer', view.ready, 17)
  check('the ceiling leaves the dead ones out', view.cap, 425)
  check('and so does what is remaining', view.remaining, 425)
  check('its row says what it is', view.rows[0].state, 'rejected')
  check('and why', view.rows[0].why, 'rejected')

  const text = Q.poolLines(view, NOW).join(NL)
  check('the report leads with the refusal', /\*\*Keys 1, 2 and 3 were refused\*\*/.test(text), true)
  check('and says waiting will not help', /Waiting will not fix those/.test(text), true)
  /* Nor will tomorrow, which is the half that was missing: the refusal used
     to vanish at midnight Pacific and the user was never told it had. */
  check('nor tomorrow', /neither will tomorrow/.test(text), true)
  /* By number, so it can be typed. "Replace the whole list" risks the
     seventeen that work for the sake of the three that do not. */
  check('and what to do instead', /\/key google drop 1 2 3/.test(text), true)
  check('and how to undo it if one comes back', /\/key google check/.test(text), true)
  check('it does not claim every key can answer', /Every key can answer/.test(text), false)
  check('the headline counts them apart', /17 of 20 keys ready, 3 refused/.test(text), true)
  check('and the table calls it refused', text.includes('refused — replace it'), true)
}

{
  /* One refused key, singular, and a 429 is NOT a refusal: it means the key
     works and is busy. */
  let pool = P.emptyPool('2026-10-12', 3)
  pool = P.restOn(pool, 1, NOW + 24 * HOUR, P.REJECTED)
  const text = Q.poolLines(P.poolView(pool, FLASH, 25, NOW, MIDNIGHT), NOW).join(NL)
  check('one refusal reads as one', /\*\*Key 2 was refused\*\*/.test(text), true)

  let busy = P.emptyPool('2026-10-12', 3)
  busy = P.restOn(busy, 1, NOW + 30_000, 'per-minute')
  const view = P.poolView(busy, FLASH, 25, NOW, MIDNIGHT)
  check('a throttled key is not refused', view.rejected, 0)
  check('it is resting', view.resting, 1)
  check('and keeps its place in the ceiling', view.cap, 75)
}

const cloudSrc = readFileSync('src/main/cloud.ts', 'utf8')
check('the check uses a models listing, not a generation', /\/models`, \{[\s\S]{0,80}Authorization/.test(cloudSrc), true)
check('which is said out loud', /is not a generation/.test(cloudSrc), true)
check('a 429 is not treated as a dead key', /res\.status === 429\) rotation\.revive/.test(cloudSrc), true)
check('a network failure is not either', /says nothing about the key/.test(cloudSrc), true)
check('dead keys leave the rotation at once', /else rotation\.reject\(index\)/.test(cloudSrc), true)
/* The free listing is the ONLY way back out of a refusal, so it has to clear
   the flag rather than just report green - otherwise a key that recovered
   stays dead until the user retypes twenty keys. */
check('and a key that answers is taken back', /rotation\.revive\(index\)/.test(cloudSrc), true)
check('and the result carries no key', /POSITIONS ONLY/.test(cloudSrc), true)
check('the reply is numbers and reasons only', /number: index \+ 1, ok: true/.test(cloudSrc), true)

const cmds = readFileSync('src/renderer/src/commands.ts', 'utf8')
check('/key google check exists', /\(check\|test\|verify\)/.test(cmds), true)
check('and is advertised in the hint', /add\|check\|drop\|clear/.test(cmds), true)

const appSrc = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the chat names the dead keys by position', /Refused: key \$\{dead\.map/.test(appSrc), true)
check('and says the check was free', /cost nothing from today/.test(appSrc), true)
check('no masked key reaches the renderer', /maskKey/.test(appSrc), false)

const barSrc = readFileSync('src/renderer/src/components/StatusBar.tsx', 'utf8')
check('the meter mentions a refusal', /REFUSED/.test(barSrc), true)

/* --------------------------------------------- dropping the ones that died */

/*
 * The check can only name positions, because a key never leaves the main
 * process. Removing three of twenty therefore meant pasting the other
 * seventeen again, which risks the working keys for the sake of the dead
 * ones - so positions have to be a handle you can act on.
 *
 * The order of removal is the trap: deleting 1 then 2 removes what used to
 * be key 3, so they come off from the end backwards.
 */
const keysSrc = readFileSync('src/main/keys.ts', 'utf8')
check('keys can be dropped by position', /drop\(provider: ProviderId, numbers: number\[\]\)/.test(keysSrc), true)
check('from the end backwards', /\.sort\(\(a, b\) => b - a\)/.test(keysSrc), true)
check('and the reason is written down', /deletes what\s*\*? ?used to be key 3/.test(keysSrc), true)
check('out-of-range numbers are ignored, not thrown', /n >= 1 && n <= list\.length/.test(keysSrc), true)
check('duplicates cannot remove two keys', /new Set\(numbers\)/.test(keysSrc), true)

const mainSrc = readFileSync('src/main/index.ts', 'utf8')
check('an empty list is refused', /Say which ones, by number/.test(mainSrc), true)
check('the models are refreshed after', /keys\.drop\(provider, asked\)[\s\S]{0,260}refreshModels/.test(mainSrc), true)

const cmdSrc = readFileSync('src/renderer/src/commands.ts', 'utf8')
check('/key google drop parses numbers', /\(drop\|remove\|delete\)/.test(cmdSrc), true)
check('and refuses words', /Which ones\?/.test(cmdSrc), true)
check('the check offers the exact command', /drop \$\{dead\.map/.test(appSrc), true)
check('and says the counts restart', /the positions moved/.test(appSrc), true)

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
/*
 * Four branches, because a refusal means two different things depending on
 * whether the keys share an allowance. Per key: a daily cap takes out one
 * MODEL on one key, a throttle holds the whole key. Shared: both apply to
 * every key, because the next key is behind the same wall and asking it
 * spends a request to learn nothing.
 */
check('a daily cap takes out one model', /rotation\.out\(index, model, nextPacificMidnight\(\)\)/.test(cloud), true)
check('a throttle still holds the key', /rotation\.rest\(index, until, 'per-minute'\)/.test(cloud), true)
check('a shared daily cap takes out every key', /rotation\.outAll\(model, nextPacificMidnight\(\)\)/.test(cloud), true)
check('and a shared throttle rests the pool', /rotation\.restAll\(until, 'per-minute \(account\)'\)/.test(cloud), true)
/* Decided by the provider's metering AND the user's answer about accounts,
   which is what CloudClient.separate joins together. */
check('which is decided by both halves', /const shared = !this\.separate\(provider\)/.test(cloud), true)
check('reading the provider and the setting', /keysAreSeparate\(provider, this\.accountMode\?\.\(provider\)\)/.test(cloud), true)
check('the per-key count is read before the rest', cloud.indexOf('const spentHere') < cloud.indexOf('rotation.out(index'), true)
check('and travels with the failure', /afterRequests: spentHere/.test(cloud), true)
check('the model being spent is stated, not spelled', /spent: true/.test(cloud), true)
check('the ledger is written after a request', /this\.remember\(provider, rotation\)/.test(cloud), true)
check('availability is asked per model', /availableCount\(Date\.now\(\), model\)/.test(cloud), true)
check('a wait is said in units people use', /friendlyWait\(wait\)/.test(cloud), true)

const main = readFileSync('src/main/index.ts', 'utf8')
check('the pool ledger is given to the client', /new CloudClient\(keys, pools,/.test(main), true)
/* And the account setting as a function, not a value: the user can change
   it mid-session and a value read at construction would go stale. */
check(
  'along with a live read of the account setting',
  /\(p\) => settings\.get\('keyAccounts'\)\[p\]/.test(main),
  true
)
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

/* ------------------------------------------- surviving a forced restart */

/*
 * `npm run restart` is `Stop-Process -Force`, so nothing in this app ever
 * gets a graceful shutdown. The ledger was written on a four-second timer,
 * and the log shows what that cost: key 1 rejected (401) at 10:50:40, three
 * restarts, and the same key rejected again at 12:21 - a request spent
 * rediscovering something that had already been written down, twice over.
 */
{
  const empty = P.emptyPool('2026-10-12', 3)
  const rested = {
    ...empty,
    spend: empty.spend.map((s, i) => (i === 1 ? { ...s, restUntil: 999, why: 'rejected' } : s))
  }
  check('a new rest is urgent', P.restsChanged(empty, rested), true)
  check('and so is one appearing from nothing', P.restsChanged(null, rested), true)
  check('an unrested pool is not', P.restsChanged(null, empty), false)
  check('and neither is the same pool again', P.restsChanged(rested, rested), false)
  const counted = {
    ...rested,
    spend: rested.spend.map((s, i) => (i === 0 ? { ...s, models: { 'gemini-3.5-flash': 4 } } : s))
  }
  check('a request count can wait for the timer', P.restsChanged(rested, counted), false)
  const out = {
    ...rested,
    spend: rested.spend.map((s, i) => (i === 2 ? { ...s, outOf: { 'gemini-3.8-flash': 123 } } : s))
  }
  check('a model going out for the day is urgent', P.restsChanged(rested, out), true)
  check('a different day is urgent', P.restsChanged(rested, { ...rested, day: '2026-10-13' }), true)
  check('and so is a different number of keys', P.restsChanged(rested, P.emptyPool('2026-10-12', 4)), true)
}

check('the store writes a rest at once', /if \(urgent\) \{\s*this\.flush\(\)/.test(ledger), true)
check('and says why it cannot wait', /Stop-Process -Force/.test(ledger), true)
check('what was restored is logged', /key pool restored for/.test(ledger), true)

const usageStore = readFileSync('src/main/usage.ts', 'utf8')
/* Once per completed turn, not once per token: a millisecond write a few
   times a minute, against the figure the meter and the measured cap use. */
check('usage is written as it happens', usageStore.indexOf('this.flush()') < usageStore.indexOf('if (!this.flushTimer)'), true)
check('and both are flushed on an orderly quit', /pools\?\.flush\(\)[\s\S]{0,40}usage\?\.flush\(\)/.test(main), true)

console.log(`${NL}${count - failed}/${count} quota checks passed`)
if (failed) process.exit(1)

/**
 * Checks the background re-ranking, which is a thing that spends the user's
 * requests without being asked.
 *
 * Asked for in these words: "every hour he uses the other API key to check
 * the availability and rank all the models... but if the token, the requests
 * are really in high demand of the user, then stop the request right now,
 * pause it, and then use the second API key to help back it up."
 *
 * So the feature is not "measure the models". It is "measure the models and
 * never be the reason anything is slower", and that half is the one worth
 * checking: every rule here is a refusal, and the only way to reach "go" is
 * for all of them to be false at once. A bug in this direction is invisible
 * - the ranking still works, the user's turns are just slightly worse, and
 * nothing in the panel would ever say why.
 *
 * Run with: npm run check:ranking
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.ranking-check.mjs')
await build({
  entryPoints: ['src/shared/ranking.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const R = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 50)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 50)} expected ${JSON.stringify(want)}`)
}

/** Everything clear: two keys, nobody asking for anything, a sweep to do. */
const CLEAR = {
  state: { on: true, keys: 2, sinceProbeMs: 60_000, sinceSweepMs: 2 * 60 * 60_000, left: 9 },
  traffic: {
    busy: false,
    sinceTurnMs: 10 * 60_000,
    lastMinute: 0,
    perMinute: 35,
    sinceLimitedMs: Infinity
  }
}
const when = (state = {}, traffic = {}) =>
  R.mayRank({ ...CLEAR.state, ...state }, { ...CLEAR.traffic, ...traffic })
const why = (state = {}, traffic = {}) => when(state, traffic).why ?? 'go'

/* --------------------------------------------------------- it does run */

check('with the coast clear it goes', when().go, true)
/* "use one API key to do the ranking, the other one to do the direct
   answering that the user sees" - the rotation starts at the front, so the
   measuring takes the back. */
check('on the last key, never the first', when().key, 1)
check('and with four keys, still the last', when({ keys: 4 }).key, 3)

/* ------------------------------------------------ and all the ways it does not */

check('off is off', why({ on: false }), 'off')
/* One key is the key answering questions. Measuring on it would be the
   feature competing with the thing it exists to improve. */
check('one key is not a spare key', why({ keys: 1 }), 'onekey')
check('and no keys is not either', why({ keys: 0 }), 'onekey')

/* The one that matters most: a turn in flight stops everything. */
check('a turn in flight stops it', why({}, { busy: true }), 'busy')
check('and so does a turn that just ended', why({}, { sinceTurnMs: 5_000 }), 'cooling')
check(
  'a minute later it is allowed again',
  when({}, { sinceTurnMs: R.QUIET_MS + 1 }).go,
  true
)

/*
 * "if the user runs out of like somehow 40 requests per minute, then use the
 * second API key for the backup and pause the ranking."
 *
 * Half the ceiling, not all of it: by the time the account is actually
 * refusing, the second key is needed as somewhere for the rotation to go,
 * and a background probe is holding it.
 */
check('half the ceiling is crowded', R.crowdedAt(35), 18)
check('and at half it stands down', why({}, { lastMinute: 18 }), 'crowded')
check('just under it, it carries on', when({}, { lastMinute: 17 }).go, true)
check('a provider with no ceiling never looks crowded', Number.isFinite(R.crowdedAt(0)), false)

/* A refusal means the account is at its wall. The ranking is the least
   important thing asking for room. */
check('after a 429 it backs off', why({}, { sinceLimitedMs: 60_000 }), 'limited')
check(
  'for ten minutes',
  when({}, { sinceLimitedMs: R.BACKOFF_MS + 1 }).go,
  true
)

/* The pacing between models, so a sweep is spread over the hour rather than
   being a nine-minute burst with the user's questions behind it. */
check('it waits between models', why({ sinceProbeMs: 1_000 }), 'paced')
check('a finished sweep waits for the hour', why({ left: 0, sinceSweepMs: 60_000 }), 'waiting')
/* Due with an empty queue means the next sweep starts - the ranker refills
   its queue on the way in, so `go` here is the hour being up rather than a
   measurement of nothing. */
check(
  'and an hour later there is work again',
  when({ left: 0, sinceSweepMs: R.EVERY_MS + 1, sinceProbeMs: R.GAP_MS + 1 }).go,
  true
)
check('due is the hour or a queue', [
  R.isDue({ left: 0, sinceSweepMs: 60_000 }),
  R.isDue({ left: 3, sinceSweepMs: 60_000 }),
  R.isDue({ left: 0, sinceSweepMs: R.EVERY_MS })
], [false, true, true])

/* ------------------------------------------------- the order of the rules */

/*
 * A busy user outranks arithmetic. With everything wrong at once the answer
 * must be the one about the person waiting, because that is the one that
 * changes what happens next.
 */
check(
  'the user comes first',
  why({ sinceProbeMs: 0, left: 0 }, { busy: true, lastMinute: 30, sinceLimitedMs: 0 }),
  'busy'
)
check('and being off comes before everything', why({ on: false }, { busy: true }), 'off')

/* ------------------------------------------------------------- what it says */

check('every reason has words', R.whyNot('crowded'), 'you are using the account')
check('ages read like a person wrote them', [R.ago(Infinity), R.ago(5 * 60_000)], [
  'never',
  '5 min ago'
])
check('and hours, once it has been a while', R.ago(3 * 3600_000), '3 h ago')

{
  const lines = R.rankLines(CLEAR.state, CLEAR.traffic, 90 * 60_000, 0).join('\n')
  check('the report says which key', lines.includes('key 2 of 2'), true)
  check('and what the ceiling is', lines.includes('of about 35'), true)
  check('and when it pauses', lines.includes('pauses at 18'), true)
  check('and that it throws cancelled work away', lines.includes('throws that measurement away'), true)
}
{
  /* One key is the case the whole design falls over in, so it says so
     rather than quietly never running. */
  const lines = R.rankLines({ ...CLEAR.state, keys: 1 }, CLEAR.traffic, Infinity, 0).join('\n')
  check('one key is explained, not hidden', lines.includes('needs a second key'), true)
  check('with the command that fixes it', lines.includes('accounts separate'), true)
}
check(
  'the settings line is short',
  R.rankSummary(
    { ...CLEAR.state, left: 0, sinceSweepMs: 20 * 60_000 },
    CLEAR.traffic,
    20 * 60_000
  ),
  'on, last 20 min ago'
)
/* Due, with nothing in the queue yet: the sweep is starting, and saying
   "measuring now (0 to go)" is how a correct verdict reads wrong. */
check(
  'and a sweep about to start says so',
  R.rankSummary({ ...CLEAR.state, left: 0 }, CLEAR.traffic, 2 * 3600_000),
  'on, starting a sweep'
)
check('thirty seconds ago is just now', R.ago(30_000), 'just now')
check(
  'and says what it is waiting for',
  R.rankSummary(CLEAR.state, { ...CLEAR.traffic, busy: true }, 20 * 60_000),
  'on, paused — waiting for your turn to finish (9 to go)'
)

console.log(failed === 0 ? '\nall ranking checks correct' : `\n${failed} ranking checks FAILED`)
process.exit(failed === 0 ? 0 : 1)

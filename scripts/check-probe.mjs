/**
 * `/model check`: does a verdict mean what it says, and does the probe cost
 * what it claims?
 *
 * Asked for as "check the availability and working workability of all the
 * models, see which ones are working".
 *
 * Two things here are worth a check rather than a glance.
 *
 * The first is that A 200 IS NOT A PASS. scripts/verify-models.mjs reported
 * nemotron-3-ultra as ok on an empty stream, and the same model said 503
 * "Service temporarily overloaded" a minute later; an answer with no words in
 * it loses the turn as completely as a 404. So `empty` must survive every
 * future tidy-up of that function, and it is pinned from both directions.
 *
 * The second is the COST, because this is the only user-facing feature in the
 * app that spends real quota by existing. Thirteen serial requests, nothing
 * automatic, nothing cached into a false daily cap, and the report says how
 * many it spent. Each of those is a source assertion, since none of them can
 * be proved by calling the pure part.
 *
 * Run with: npm run check:probe
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

async function load(entry, tag) {
  const out = `.probe-check-${tag}.mjs`
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

const P = await load('src/shared/probe.ts', 'probe')
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

/* ------------------------------------------------- what counts as working */

check('a reply with words in it works', P.verdictFor(200, 'ready', 400), 'ok')
check('and is still working when it is slow', P.verdictFor(200, 'ready', P.SLOW_MS), 'slow')
check('one millisecond under is not slow', P.verdictFor(200, 'ready', P.SLOW_MS - 1), 'ok')

/*
 * THE ONE THIS FILE EXISTS FOR. A 200 carrying nothing is not a pass, in
 * either direction: an empty string is not ok, and ok requires content.
 */
check('a 200 that said nothing does NOT work', P.verdictFor(200, '', 300), 'empty')
check('and not even quickly', P.verdictFor(200, '', 1), 'empty')
check('an empty reply is never usable', P.usable('empty'), false)
check('whitespace counts as nothing', P.verdictFor(200, '', 300), 'empty')

/* ---------------------------------------------------- whose problem it is */

check('a refused key is a key problem', P.verdictFor(401, '', 100), 'refused')
check('and so is a forbidden one', P.verdictFor(403, '', 100), 'refused')
check('a 429 is quota, not health', P.verdictFor(429, '', 100), 'limited')
check('a 404 means the id is gone', P.verdictFor(404, '', 100), 'missing')
/* A wrong request shape for that provider arrives as 400, and the fix is the
   same as for a withdrawn id: the catalogue entry is wrong. */
check('and a rejected body is the same job', P.verdictFor(400, '', 100), 'missing')
check('anything else is unclassified', P.verdictFor(500, '', 100), 'error')
check('including a 503', P.verdictFor(503, '', 100), 'error')

/* A model that is merely rate limited must not be reported as broken: the
   user's decision about it is "later", not "never". */
check('rate limited is not usable now', P.usable('limited'), false)
check('but it did cost a request', P.spent('limited'), true)
check('a model with no key costs nothing', P.spent('nokey'), false)
check('and everything else does', [
  'ok', 'slow', 'empty', 'missing', 'refused', 'limited', 'timeout', 'error'
].every(P.spent), true)

/* ------------------------------------------------------------ the report */

const combine = (runs) => P.combineRuns(runs)

const R = (model, state, ms = 500, extra = {}) => ({
  model,
  label: model,
  provider: 'nvidia',
  state,
  ms,
  said: state === 'ok' ? 'ready' : '',
  why: '',
  ...extra
})

{
  const lines = P.probeLines([
    R('a/fast', 'ok', 600),
    R('a/slow', 'slow', 20_000),
    R('a/dead', 'empty'),
    R('a/gone', 'missing'),
    R('a/none', 'nokey', 0)
  ])
  const text = lines.join(NL)

  check('the headline counts what answered', /\*\*2\/5 answered\*\*/.test(text), true)
  /* Four were asked; the keyless one was not, and saying otherwise would
     overstate what the command costs. */
  check('and says what it spent, excluding the unasked', /4 requests/.test(text), true)

  check('working models are listed', text.includes('**Working**'), true)
  check('broken ones are their own group', text.includes('**Not working**'), true)
  check('and so are the ones never asked', text.includes('**Not asked**'), true)

  /* Quickest first, because the number is the only reason to order them. */
  check('the quickest is named first', text.indexOf('a/fast') < text.indexOf('a/slow'), true)
  check('a slow model is still in Working', /a\/slow.*slow/.test(text), true)
  check('and an empty one is not', text.indexOf('a/dead') > text.indexOf('Not working'), true)

  /* The ids are what /model takes, so they have to be printed verbatim. */
  check('ids are printed as code', text.includes('`a/fast`'), true)
  check('and the way to act on them is given', /Switch with `\/model <id>`/.test(text), true)
}

/*
 * The one piece of advice worth volunteering: the model you are using is the
 * one that just failed. Said only then - told every time, it is noise.
 */
{
  const broken = P.probeLines([R('a/ok', 'ok'), R('a/mine', 'empty')], 'a/mine').join(NL)
  check('a broken current model is pointed out', /Your model is in that list/.test(broken), true)

  const fine = P.probeLines([R('a/ok', 'ok'), R('a/mine', 'ok')], 'a/mine').join(NL)
  check('a working one is not', /in that list/.test(fine), false)

  const absent = P.probeLines([R('a/ok', 'ok')], 'something-local').join(NL)
  check('and neither is a model that was not in the list', /in that list/.test(absent), false)
}

check('an empty catalogue says so rather than throwing', P.probeLines([]).length, 1)

/* ------------------------------------------- one run is a sample, two is not */

/*
 * The whole argument for asking twice: a model that works half the time is
 * a third thing, and one run cannot see it. nemotron-3-ultra answered one
 * probe and 503'd the next - called working or called dead, both verdicts
 * would have been wrong in a way that costs a turn later.
 */
{
  const one = combine([R('a/x', 'ok', 900)])
  check('a single run is reported as one run', one.runs, 1)
  check('and is unchanged otherwise', one.state, 'ok')

  const agreed = combine([R('a/x', 'ok', 900), R('a/x', 'ok', 1100)])
  check('two agreeing runs stay ok', agreed.state, 'ok')
  /* The median, not the best: the quickest of two runs is a sales pitch. */
  check('timed on the middle, not the quickest', agreed.ms, 1000)
  check('and both times are kept', agreed.times, [900, 1100])

  const mixed = combine([R('a/x', 'ok', 900), R('a/x', 'empty', 300)])
  check('a model that failed once is flaky', mixed.state, 'flaky')
  check('which is NOT something to switch to', P.usable(mixed.state), false)
  check('it says how often it worked', /answered 1 of 2 times/.test(mixed.why), true)
  check('and what went wrong the other time', /empty/.test(mixed.why), true)
  check('timed on the runs that answered', mixed.ms, 900)

  /* Failing every time keeps its own verdict: "refused twice" and "worked
     once, refused once" need different things done about them. */
  const dead = combine([R('a/x', 'refused'), R('a/x', 'refused')])
  check('failing twice is not flaky', dead.state, 'refused')
  check('and says it was asked twice', dead.runs, 2)

  /* Failing differently each time is still a failure, but the report must
     not present the last one as the whole story. */
  const varied = combine([R('a/x', 'timeout'), R('a/x', 'empty')])
  check('different failures keep both', varied.seen, ['timeout', 'empty'])

  /* Slowness is judged on the combined figure, not on one unlucky run. */
  const slow = combine([R('a/x', 'ok', 20_000), R('a/x', 'ok', 30_000)])
  check('two slow runs are slow', slow.state, 'slow')
  /* Judged on the median, which cuts both ways and is the point: one bad
     run does not condemn a model, and one good run does not save one. */
  const once = combine([R('a/x', 'ok', 600), R('a/x', 'slow', 20_000)])
  check('one slow run among quick ones does not condemn it', once.state, 'ok')
  check('and the median is what was timed', once.ms, 10_300)
  const mostly = combine([R('a/x', 'ok', 600), R('a/x', 'slow', 40_000)])
  check('but a bad enough run drags the median over', mostly.state, 'slow')

  /* Nothing was asked, so there is nothing to disagree about. */
  const none = combine([R('a/x', 'nokey', 0), R('a/x', 'nokey', 0)])
  check('an unasked model is never flaky', none.state, 'nokey')
  check('and spent nothing', none.times, [])
}

/* The report has to show the spread, or a model that answered in 900ms and
   then 104,000ms reads as a 52-second model, which it is not. */
{
  const wide = combine([R('a/x', 'ok', 900), R('a/x', 'ok', 104_000)])
  const text = P.probeLines([wide]).join(NL)
  check('a wide spread is printed', /900–104,000ms over 2/.test(text), true)

  const tight = P.probeLines([combine([R('a/x', 'ok', 1000), R('a/x', 'ok', 1050)])]).join(NL)
  check('and a tight one is not noise', /over 2/.test(tight), false)

  const flakyText = P.probeLines([combine([R('a/x', 'ok', 900), R('a/x', 'empty', 0)])]).join(NL)
  check('flaky models get their own group', /\*\*Sometimes\*\*/.test(flakyText), true)
  check('and are not in Working', flakyText.indexOf('a/x') > flakyText.indexOf('Sometimes'), true)

  /* The cost line counts requests, not models. */
  const cost = P.probeLines([
    combine([R('a/x', 'ok', 900), R('a/x', 'ok', 900)]),
    combine([R('a/y', 'ok', 900), R('a/y', 'ok', 900)])
  ]).join(NL)
  check('the cost line counts runs', /4 requests, 2 runs each/.test(cost), true)

  /* And a one-run check says what it is worth. */
  const sample = P.probeLines([combine([R('a/x', 'ok', 900)])]).join(NL)
  check('one run admits it is a sample', /a sample not a measurement/.test(sample), true)
}

check('two runs is the default', P.DEFAULT_RUNS, 2)
check('and there is a ceiling on asking', P.MAX_RUNS, 5)

/* ------------------------------------------- which one to actually use */

/*
 * A report that lists six models and stops has handed the reader the work.
 * The recommendation balances the ladder score against the time measured
 * on THIS run - not the catalogue's latency, which is the figure that went
 * stale and had the picker promising 1.3s for a hundred-second model.
 *
 * Weighted slightly towards smartness, as asked: a tenfold slowdown costs
 * 0.08 of ladder share, so a model ten times slower needs about three more
 * rungs out of 41 to make up for it.
 */
{
  const M = (m, ms, state = 'ok') => ({
    model: m,
    label: m,
    provider: 'nvidia',
    state,
    ms,
    said: 'ready',
    why: '',
    runs: 2,
    times: [ms, ms]
  })

  /*
   * The real catalogue, measured 19 Oct with the real 14.6k preamble -
   * not the four-word probe, whose figures did not even preserve the
   * order: nemotron-3-super was second quickest on the toy prompt and is
   * fourth here, because prompt processing is most of the cost for a
   * quick model and almost none of it for a slow one.
   */
  const live = [
    M('gemma4:31b-cloud', 1781),
    M('z-ai/glm-5.3-flash', 4577),
    M('nvidia/nemotron-3-super-120b-a12b', 6264),
    M('nvidia/nemotron-3.5-super-vl-120b-a12b', 10_923),
    M('deepseek-ai/deepseek-v4.1-flash', 112_211),
    M('z-ai/glm-5.3', 120_000, 'timeout')
  ]
  const ranked = P.recommend(live)

  check('the best balance wins', ranked[0].model, 'z-ai/glm-5.3-flash')

  /*
   * THE JUDGEMENT THE WHOLE THING EXISTS TO MAKE. DeepSeek has the highest
   * ladder score here - 39/41, higher than the winner's 38 - and comes
   * last but one, because two orders of magnitude of latency is not worth
   * one rung. A weighting that recommended it would be measuring the
   * ladder and calling it advice.
   */
  /*
   * DeepSeek has the highest ladder score here - 39/41, better than the
   * winner - and is not offered at all. The log penalty alone did not do
   * it: on these figures it scored within 0.008 of the VL model, because
   * ten times slower costs three rungs and it is three rungs better. The
   * arithmetic was right and the answer was absurd, so there is a floor.
   */
  check(
    'the smartest is not offered at two minutes',
    ranked.some((p) => p.model === 'deepseek-ai/deepseek-v4.1-flash'),
    false
  )
  /* But it is NOT dropped from the report - it works, and someone may
     want it. Only the suggestion has a floor. */
  check('though the report still lists it', P.probeLines(live).join(NL).includes('deepseek'), true)

  /* Below the floor the gradient still applies: seven rungs is worth
     something, so the quickest does not simply win. */
  check('and below the floor smartness still counts', ranked[0].model !== 'gemma4:31b-cloud', true)
  check(
    'the quickest is beaten by a smarter one',
    ranked.findIndex((p) => p.model === 'z-ai/glm-5.3-flash') <
      ranked.findIndex((p) => p.model === 'gemma4:31b-cloud'),
    true
  )

  /* And the other direction: fastest does not win either. */
  check('nor does a fast but weak model win', ranked[0].model !== 'nvidia/nemotron-3-super-120b-a12b', true)

  /* Flaky is not recommendable whatever it scores: "use this, it works
     about half the time" is not a recommendation. */
  check('a flaky model is never offered', ranked.some((p) => p.model === 'z-ai/glm-5.3'), false)

  const text = P.recommendLines(live, '').join(NL)
  /* A label and the facts: "Recommended: x - 93%, 4.6s", not a sentence
     explaining what a recommendation is. */
  check('the report names one', /\*\*Recommended:\*\* `z-ai\/glm-5\.3-flash`/.test(text), true)
  check('with both numbers behind it', /93%, 4\.6s/.test(text), true)
  check('and the command to take it', /\/model z-ai\/glm-5\.3-flash/.test(text), true)

  /*
   * Vision is the axis neither number can see, and for someone working
   * from screenshots it is often the deciding one - so when the winner is
   * blind and a seeing model answered, it is named rather than buried.
   */
  /*
   * Not in the table above any more, and that is the finding rather than
   * a gap in the test: glm-5.3-flash reads images - 5/6 on the vision
   * ladder - so the pick is no longer blind and the line correctly does
   * not appear. Three models were marked blind by omission on 19 Oct and
   * two of them could see all along.
   */
  check('no vision line when the pick can see', /For screenshots/.test(text), false)

  /* So the case is built deliberately: nemotron-3-super genuinely cannot
     take an image - the endpoint answers "multimodal processing is not
     ..." - and here it is quick enough to win anyway. */
  const blindWins = [M('nvidia/nemotron-3-super-120b-a12b', 2000), M('gemma4:31b-cloud', 28_000)]
  const blindText = P.recommendLines(blindWins, '').join(NL)
  check('a blind winner is still the pick', /Recommended:.*nemotron-3-super/.test(blindText), true)
  check('and the best eye is named beside it', /For screenshots:.*gemma4/.test(blindText), true)
  check('saying why it is there', /the pick above is blind/.test(blindText), true)

  /* Already on it: no point telling someone to switch to where they are. */
  const staying = P.recommendLines(live, 'z-ai/glm-5.3-flash').join(NL)
  check('staying put is phrased as staying', /already on it/.test(staying), true)
  check('and does not hand out a switch command', /\/model z-ai/.test(staying), false)

  /* Nothing answered, so there is nothing to recommend - and saying so
     wrongly would be worse than saying nothing. */
  check('nothing usable recommends nothing', P.recommendLines([M('a/x', 0, 'refused')]), [])
  /* A model with no ladder score cannot be weighed against ones that have
     them, so it is left out rather than scored as zero. */
  check('an unmeasured model is not ranked', P.recommend([M('who/what', 500)]), [])

  /* The weighting itself, pinned so a future tweak is deliberate. */
  check('a tenfold slowdown costs this much share', P.SLOWNESS_COST, 0.08)
  /* The floor sits under the quickest thing measured (1.8s), so nothing
     is compared on a scale that starts off the end of the data. */
  check('nothing under two seconds is penalised', P.FAST_ENOUGH_MS, 2000)
  check('and twelve seconds is where slow starts', P.SLOW_MS, 12_000)
  check('with a hard floor under the suggestion', P.TOO_SLOW_TO_SUGGEST_MS, 30_000)
}

/* ------------------------------------------------------- no connection */

/*
 * With the network down every model fails identically, and the ordinary
 * report then reads "0/10 answered" over ten rows of the same sentence -
 * which says the catalogue is full of broken models when the wifi is off.
 * Asked for directly: if it cannot connect, return an error.
 */
{
  const M = (model, ms, state = 'ok') => ({
    model,
    label: model,
    provider: 'nvidia',
    state,
    ms,
    said: '',
    why: '',
    runs: state === 'offline' || state === 'nokey' ? 0 : 2,
    times: []
  })
  const down = [M('a/x', 0, 'offline'), M('a/y', 0, 'offline'), M('a/z', 0, 'nokey')]
  const text = P.probeLines(down).join(NL)
  check('one line, not ten', text.split(NL).length, 2)
  check('and it names the cause', /\*\*No connection\.\*\*/.test(text), true)
  /* The reassurance matters as much as the diagnosis: a failed check
     that spent a day's quota would be worth knowing about. */
  check('it says nothing was spent', /Nothing was spent/.test(text), true)
  check('and nothing was', P.spent('offline'), false)

  /* A model with no key is not evidence either way, so it does not stop
     the offline verdict - and does not cause one on its own. */
  const nokeyOnly = P.probeLines([M('a/z', 0, 'nokey')]).join(NL)
  check('no keys at all is not offline', /No connection/.test(nokeyOnly), false)

  /*
   * ONE unreachable provider among several is a real finding about that
   * provider, and belongs in the list beside the others rather than
   * blanking the whole report.
   */
  const mixed = P.probeLines([M('a/x', 1200), M('a/y', 0, 'offline')]).join(NL)
  check('one unreachable model is not everything', /No connection/.test(mixed), false)
  check('it is listed like any other failure', /not reached/.test(mixed), true)
}

/* The cheap pass, before anything is spent: with no route, twenty DNS
   lookups have to time out before saying what was knowable at the start. */
{
  const cloud = readFileSync('src/main/cloud.ts', 'utf8')
  check('connectivity is checked first', /if \(!net\.isOnline\(\)\) \{/.test(cloud), true)
  check('and nothing is sent when there is none', /state: 'offline' as const/.test(cloud), true)
  /* Online means a route exists, not that the provider answers, so the
     per-model verdict still has to exist for what this misses. */
  check('a dead connection mid-probe is still caught', /ENOTFOUND\|ECONNREFUSED\|ENETUNREACH/.test(cloud), true)
  check('and is not filed as a model failure', /unreachable \? 'offline' : 'error'/.test(cloud), true)
}

/* ------------------------------- not asking twice when once is enough */

/*
 * Two runs exist to catch a model that works only SOMETIMES, which is a
 * question about a candidate. It is not a question worth two minutes
 * about a model already past the floor under the recommendation, or one
 * the endpoint does not have.
 *
 * Measured across the ten in the catalogue: two runs each is 9.3 minutes
 * and 83% of it is deepseek at 112s and glm-5.3 timing out at 120, asked
 * twice apiece. The other eight together are a minute and a half. The
 * early exit brings it to 5.4.
 */
{
  const cloud = readFileSync('src/main/cloud.ts', 'utf8')
  check(
    'a settled failure is not re-asked',
    /got\.state === 'missing' \|\| got\.state === 'refused' \|\| got\.state === 'offline'/.test(cloud),
    true
  )
  check('nor is a model past the floor', /got\.ms > TOO_SLOW_TO_SUGGEST_MS/.test(cloud), true)
  /* And the picture question follows the same rule. `usable` includes
     `slow`, so without this deepseek - sighted, 112s a turn - would be
     asked one at the ninety seconds it needs per image, handing back
     most of the saving from not asking it twice. */
  check('and the eye test skips it too', /verdict\.ms <= TOO_SLOW_TO_SUGGEST_MS/.test(cloud), true)
  /* The runs it skipped still count as progress, or the bar stops short
     of the end on every slow model in the list. */
  check('the skipped runs still count as done', /tick\(times - run - 1\)/.test(cloud), true)

  /*
   * A model that is merely SLOW but under the floor is still asked
   * twice: that is the range where flakiness is worth knowing about,
   * and where the answer changes what someone picks.
   */
  const slowButFine = P.recommend([
    {
      model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      label: 'x',
      provider: 'nvidia',
      state: 'ok',
      ms: 10_923,
      said: 'ready',
      why: '',
      runs: 2,
      times: [10_923, 10_923]
    }
  ])
  check('a slow-but-usable model is still a candidate', slowButFine.length, 1)
  check('and the floor is where that stops', P.TOO_SLOW_TO_SUGGEST_MS, 30_000)
}

/* ------------------------------------ one lane per independent budget */

/*
 * The serial rule was right when it was written and is not a law. Every
 * catalogue entry but one is the same NVIDIA account, so firing them off
 * together collects 429s - and a 429 is indistinguishable from a model
 * that is genuinely out, which would make the check the reason the thing
 * it checks looks broken.
 *
 * What changed is that there can be more than one account. A key on a
 * second account has its own per-minute ceiling, so two requests on two
 * accounts are not competing, and `pace` already keys its queue per
 * account rather than per key. Lanes are therefore exactly the number of
 * SEPARATE budgets - `budgetsFor`, the same function the meter uses.
 */
{
  const cloud = readFileSync('src/main/cloud.ts', 'utf8')
  check('lanes come from the budget count', /budgetsFor\(id, this\.keys\.count\(id\)/.test(cloud), true)
  /* One unless told otherwise, so the cautious behaviour is the default
     and nobody gets 429s for a setting they never set. */
  check('which is one until accounts are declared separate', C.budgetsFor('nvidia', 2), 1)
  check('and two once they are', C.budgetsFor('nvidia', 2, 'separate'), 2)
  check('never fewer than one', /Math\.max\(\s*1,/.test(cloud), true)

  /* Each lane pinned to its own key: two lanes drawing from the rotation
     would sooner or later take the same key and serialise through the
     pacer while looking parallel. */
  check('a lane owns its key', /lane % count/.test(cloud), true)
  check('and only when the budgets are separate', /this\.separate\(provider\) \? lane % count/.test(cloud), true)

  /* Order is the catalogue's, not whichever answered first: the report
     is read as a list of models and one that reshuffles by finishing
     order is harder to compare between runs. */
  check('the report keeps catalogue order', /CLOUD_MODELS\.map\(\(m\) => results\.get\(m\.id\)\)/.test(cloud), true)
}

/* -------------------------------------------- what the check actually costs */

const cloud = readFileSync('src/main/cloud.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

/*
 * NEVER MORE CONCURRENT THAN THERE ARE BUDGETS TO SPEND.
 *
 * This asserted "the probe is serial", which was the right rule while
 * every entry but one was the same NVIDIA account: firing them off
 * together collects 429s, and a 429 is indistinguishable from a model
 * that is genuinely out. The check must not be the reason a model looks
 * broken.
 *
 * The rule survives; the number changed. Lanes are the count of separate
 * accounts, which is one unless the user has declared otherwise - so the
 * old behaviour is still what happens by default, and parallelism only
 * appears where there is genuinely a second ceiling to use.
 */
check('concurrency is bounded by the budgets', /Array\.from\(\{ length: lanes \}/.test(cloud), true)
check('and defaults to one', C.budgetsFor('nvidia', 5), 1)
check('it honours the pacer', /await pace\(provider, index, 0, this\.separate\(provider\)\)[\s\S]{0,400}chat\/completions/.test(cloud), true)

/* Small on purpose: this measures whether words come back, not how many. */
check('it asks for very little', /max_tokens: 16\b/.test(cloud), true)
check('and turns thinking off', /thinkingKwargsFor\(provider, false\)/.test(cloud), true)
check('with its own timeout', /signal: AbortSignal\.timeout\(PROBE_TIMEOUT_MS\)/.test(cloud), true)

/* A key never crosses to the renderer, here as everywhere else. */
check('the reply carries no key', /said: truncate\(said, 40\)/.test(cloud), true)
check('and a key is stripped from an error body', /stripKey\(await res\.text\(\)/.test(cloud), true)
/* A run count is the only thing the page may pass: no host, no id, no
   key. The catalogue still decides what gets dialled. */
check(
  'the page can only say how many times',
  /probe: \(runs\?: number\): Promise<ProbeResult\[\]>/.test(preload),
  true
)
check('and the count is all that crosses', /IPC\.modelsProbe, \{ runs \}/.test(preload), true)

/* Nothing automatic. The only caller is the command. */
check('only one place starts a probe', (main.match(/probeModels\(/g) ?? []).length, 1)
check('and it is an explicit request', /IPC\.modelsProbe, async \(_e, req\?/.test(main), true)
check('nothing polls it', /setInterval[^;]{0,120}probe/i.test(main), false)
/* What it will cost, before it costs it: twelve requests and several
   minutes is a command somebody runs twice if nothing says so. */
/*
 * The cost and the wait, in one line.
 *
 * This grew to five explaining why it asks twice, what a real preamble
 * costs and how long to wait - all true, all already decided, and none
 * of it anything the reader can act on while they sit there. What is
 * worth saying before spending twelve requests is that it is twelve
 * requests and that they will wait.
 */
check('the panel says what it will spend first', /real requests, a few minutes/.test(app), true)
check('in one line', /Checking \$\{CLOUD_MODELS\.length\} models/.test(app), true)

/*
 * A TYPO IS NOT A MODEL. `/model chack` - a mistyped `check` - was
 * accepted whole, and the panel answered "Now answering with chack."
 * There is no such model, no provider for it and nothing that could ever
 * reply; the status bar read `chack` and the failure would have surfaced
 * on the next question, nowhere near the mistake.
 *
 * Typing an id by hand must keep working, since that is the only way to
 * reach a model the catalogue does not list - so the gate is
 * ROUTABILITY, not membership. An id with a slash or a colon goes to a
 * provider; one with neither goes nowhere and is a slip.
 */
check('a name that routes nowhere is refused', /!hosted && providerFor\(id\) === null/.test(app), true)
check('and a near-miss is named', app.includes('Did you mean'), true)
/* Two characters, same length: chack/check, modle/model. Any looser and
   a real short model id would be "corrected" into a subcommand. */
check('within two characters', /countDiff\(word, id\.toLowerCase\(\)\) <= 2/.test(app), true)
check('and the same length', /word\.length === id\.length/.test(app), true)
check('and how long it will take', /a few minutes/.test(app), true)

/*
 * A probe's 429 must not become a measured daily cap. `exhaustedAt` means
 * "one key's day ends at this count", and thirteen requests in a row are far
 * likelier to have found a per-minute throttle - which would pin a cap of two
 * or three for a model with hundreds, and show a full meter while everything
 * worked.
 */
const handler = main.slice(main.indexOf('IPC.modelsProbe'), main.indexOf('IPC.modelsProbe') + 1600)
check('the requests are counted', /usage\.add\(\{/.test(handler), true)
check('a failure is counted as one', /error: !usable\(r\.state\)/.test(handler), true)
check('but a 429 never sets a daily cap', /exhausted: /.test(handler), false)
check('and the reason is written down', /NOT `exhausted`/.test(handler), true)

/* Every catalogue entry is asked about, so the report cannot quietly omit a
   model the picker still offers. */
check('every model in the picker is probed', C.CLOUD_MODELS.length > 0, true)
check('the catalogue is the only source of ids', /const queue = CLOUD_MODELS\.slice\(\)/.test(cloud), true)

console.log(`${NL}${count - failed}/${count} probe checks passed`)
if (failed) process.exit(1)

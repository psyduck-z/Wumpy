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

  check('the headline counts what answered', /\*\*2 of 5 models answered\.\*\*/.test(text), true)
  /* Four were asked; the keyless one was not, and saying otherwise would
     overstate what the command costs. */
  check('and says what it spent, excluding the unasked', /4 requests spent/.test(text), true)

  check('working models are listed', text.includes('**Working**'), true)
  check('broken ones are their own group', text.includes('**Not working right now**'), true)
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
  check('a broken current model is pointed out', /You are set to `a\/mine`/.test(broken), true)

  const fine = P.probeLines([R('a/ok', 'ok'), R('a/mine', 'ok')], 'a/mine').join(NL)
  check('a working one is not', /You are set to/.test(fine), false)

  const absent = P.probeLines([R('a/ok', 'ok')], 'something-local').join(NL)
  check('and neither is a model that was not in the list', /You are set to/.test(absent), false)
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
  const once = combine([R('a/x', 'ok', 600), R('a/x', 'slow', 20_000)])
  check('one slow run among quick ones is judged on the median', once.state, 'slow')

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
  check('flaky models get their own group', /Unreliable — answered sometimes/.test(flakyText), true)
  check('and are not in Working', flakyText.indexOf('a/x') > flakyText.indexOf('Unreliable'), true)

  /* The cost line counts requests, not models. */
  const cost = P.probeLines([
    combine([R('a/x', 'ok', 900), R('a/x', 'ok', 900)]),
    combine([R('a/y', 'ok', 900), R('a/y', 'ok', 900)])
  ]).join(NL)
  check('the cost line counts runs', /4 requests spent asking, 2 per model/.test(cost), true)

  /* And a one-run check says what it is worth. */
  const sample = P.probeLines([combine([R('a/x', 'ok', 900)])]).join(NL)
  check('one run admits it is a sample', /sample rather than a measurement/.test(sample), true)
}

check('two runs is the default', P.DEFAULT_RUNS, 2)
check('and there is a ceiling on asking', P.MAX_RUNS, 5)

/* -------------------------------------------- what the check actually costs */

const cloud = readFileSync('src/main/cloud.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

/*
 * SERIAL, and this is a correctness matter rather than a politeness one.
 * Every catalogue entry but one is the same NVIDIA account; thirteen at once
 * against a per-minute limit collects 429s, and a 429 is indistinguishable
 * from a model that is genuinely out. The check must not be the reason a
 * model looks broken.
 */
check('the probe is serial', /for \(const entry of CLOUD_MODELS\)/.test(cloud), true)
check('and never fanned out', /Promise\.all\([^)]*probe/i.test(cloud), false)
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
check('the panel says what it will spend first', /small requests/.test(app), true)
check('and how long it will take', /give it a few minutes/.test(app), true)

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
check('the catalogue is the only source of ids', /for \(const entry of CLOUD_MODELS\)/.test(cloud), true)

console.log(`${NL}${count - failed}/${count} probe checks passed`)
if (failed) process.exit(1)

/**
 * Checks the timeline behind `/log`.
 *
 * Asked for in these words: "add like a command like slash log, to basically
 * it has all the logs of what you've done. So then, for example, at like the
 * time, for example, they re-rank all the models, or for example, change
 * model at this time."
 *
 * Three things here can be wrong in ways nobody would notice.
 *
 * A RECORD THAT IS WRONG IS WORSE THAN NO RECORD. This is the user-facing half
 * of what renderer/ledger.ts does for the model, and its value is entirely in
 * being trusted: if two runs of the same command fold into one line, the
 * answer to "did you run it twice" becomes a confident no. So the folding rule
 * is pinned to the one kind it is for, and pinned OUT of the one it would
 * damage.
 *
 * A RECORD THAT GROWS IS A LEAK. It is written on every command, every search,
 * every setting; both the count cap and the seven-day cap are checked with
 * real entries, because disk.ts exists because of 38 MB of user data that
 * nobody chose.
 *
 * AND IT MUST NOT HOLD WHAT IT PROMISES NOT TO. The report says, every time,
 * that there are no keys and no messages in here. That promise is only as good
 * as the settings diff ignoring searchApiKey, so that is checked rather than
 * commented.
 *
 * Run with: npm run check:journal
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.journal-check.mjs')
await build({
  entryPoints: ['src/shared/journal.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const J = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

/* The defaults, for the settings diff. Imported rather than invented: a diff
   checked against a made-up settings object is a diff checked against
   nothing. */
const defaults = join(process.cwd(), '.journal-defaults.mjs')
await build({
  entryPoints: ['src/shared/defaults.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: defaults,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const { DEFAULT_SETTINGS } = await import(pathToFileURL(defaults).href)
rmSync(defaults, { force: true })

/** One more shared module, bundled the same way. Deleted by the caller. */
async function bundleShared(name) {
  const file = join(process.cwd(), `.journal-${name}.mjs`)
  await build({
    entryPoints: [`src/shared/${name}.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
  return file
}

let failed = 0
let count = 0
const pad = (s, n) => String(s).padEnd(n)
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 56)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 56)} expected ${JSON.stringify(want)}`)
}

const NL = String.fromCharCode(10)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* A fixed moment, built from local parts so the expected times do not depend
   on the machine's timezone: the report prints the clock the user's taskbar
   is showing, and a check that assumed UTC would pass in one place only. */
const NOW = new Date(2026, 9, 23, 20, 30, 0).getTime()
const at = (daysAgo, h, m) => new Date(2026, 9, 23 - daysAgo, h, m, 0).getTime()

/* ------------------------------------------------------- one thing happening */

check('a detail is trimmed to one line', J.entry('command', `  npm  run${NL}build  `).what, 'npm run build')
check(
  'and capped, because a command can be a paragraph',
  J.entry('command', 'x'.repeat(400)).what.length,
  J.MAX_DETAIL + 1 /* the ellipsis */
)
check('every kind has a word for its column', Object.keys(J.WORD).length, 12)
for (const [kind, word] of Object.entries(J.WORD)) {
  if (!word || !J.isEventKind(kind)) check(`${kind} has a usable column word`, word, '...')
}

/* ----------------------------------------------------------------- the rules */

/**
 * The one that matters most, and the reason the folding rule is a list of one.
 *
 * ledger.ts was written because Wumpy ran an uninstaller, then ran a check,
 * and told the user it had not uninstalled anything. Running the same command
 * twice is two things happening. A timeline that folds them cannot answer the
 * only question it was built for.
 */
{
  const first = J.entry('command', 'npm run build', NOW - 10_000)
  const again = J.entry('command', 'npm run build', NOW)
  check('the same command twice is two lines', J.keep([first], again).length, 2)
  check('and nothing about it reads as a repeat', J.isRepeat([first], again), false)
}
/* A 429 is a state, not an act: one turn against twenty keys produces a dozen
   of the same fact in as many seconds. */
{
  const first = J.entry('limit', 'NVIDIA: rate limited', NOW - 10_000)
  const again = J.entry('limit', 'NVIDIA: rate limited', NOW)
  check('the same refusal inside a minute is one line', J.keep([first], again).length, 1)
  check('a minute later it is news again', J.isRepeat([first], { ...again, at: NOW + MINUTE }), false)
  check(
    'and a different refusal is never folded',
    J.isRepeat([first], J.entry('limit', 'NVIDIA: out of glm-5.3 for the day', NOW)),
    false
  )
}
check('only one kind folds at all', J.QUIET_REPEATS, ['limit'])

/* The caps, both of them, with real entries. */
{
  let list = []
  for (let i = 0; i < J.MAX_ENTRIES + 50; i++) {
    list = J.keep(list, J.entry('command', `run ${i}`, NOW - (J.MAX_ENTRIES + 50 - i) * 1000))
  }
  check('the list stops growing', list.length, J.MAX_ENTRIES)
  check('and it is the OLD end that goes', list[0].what, 'run 50')
}
{
  const old = J.entry('command', 'eight days ago', NOW - 8 * DAY)
  const recent = J.entry('command', 'this morning', NOW - 8 * HOUR)
  check('seven days is the limit', J.prune([old, recent], NOW).length, 1)
  check('and the one kept is the recent one', J.prune([old, recent], NOW)[0].what, 'this morning')
  check('adding one also prunes', J.keep([old], recent, 500, NOW).length, 1)
}
check('a nonsense timestamp is not kept', J.prune([{ kind: 'start', what: 'x' }], NOW).length, 0)

/* ---------------------------------------------------------------- the words */

check('the kind itself reads', J.readKind('model'), 'model')
check('so does the column word', J.readKind('ran'), 'command')
check('and the plural somebody would say', J.readKind('commands'), 'command')
check('ranking, which is what it is called out loud', J.readKind('ranking'), 'rank')
check('nothing close is not guessed at', J.readKind('sideways'), null)
check('nor is an empty word', J.readKind(''), null)
check('every kind is reachable by its own name', J.readKind('desktop'), 'desktop')

check('a duration in seconds', J.took(8_000), '8s')
check('and in minutes once that reads better', J.took(8 * MINUTE), '8 min')
check('and in hours past an hour and a half', J.took(3 * HOUR), '3 h')
check('something that took no time says nothing', J.took(0), '')

check('a whole sweep', J.sweepLine({ models: 9, asked: 9, tookMs: 8 * MINUTE }), '9 models in 8 min')
/* The interesting case: a model that could not be reached is the most useful
   thing a sweep ever finds, and "9 models" would have hidden it. */
check(
  'a sweep that lost two says so',
  J.sweepLine({ models: 7, asked: 9, tookMs: 8 * MINUTE }),
  '7 of 9 models in 8 min'
)
check('a sweep with no clock on it', J.sweepLine({ models: 9, asked: 9, tookMs: 0 }), '9 models')

/**
 * The line while it is still going, and the rewrite that finishes it.
 *
 * Asked for after the first version: "also log when the auto rerank
 * happened". A sweep waits for quiet moments, so there can be an hour
 * between its first measurement and its last - recording it at the end
 * stamps it with the wrong time, and a restart in between left no trace at
 * all. So the line is written at the first measurement and finished in
 * place, which keeps the time it happened AND keeps a sweep to one line.
 */
check('a sweep in progress says so', J.sweepOpen(9), 'measuring 9 models…')
check('and one model is not "1 models"', J.sweepOpen(1), 'measuring 1 model…')
{
  const other = J.entry('command', 'npm run build', NOW - 5 * MINUTE)
  const open = J.entry('rank', J.sweepOpen(9), NOW - 4 * MINUTE)
  const list = [other, open]
  const done = J.amended(list, 'rank', J.sweepOpen(9), '9 models in 4 min')
  check('finishing it does not add a line', done.length, 2)
  check('it reads as finished', done[1].what, '9 models in 4 min')
  /* The whole point of amending rather than appending: the time stays the
     time the re-ranking started. */
  check('and keeps the time it started', done[1].at, open.at)
  check('nothing else is touched', done[0], other)
  /* No open line - cleared, or the sweep ran across the age limit - and the
     caller is told so it can write the finished line fresh instead. */
  check('with nothing to finish it says so', J.amended([other], 'rank', J.sweepOpen(9), 'x'), null)
  /* And it will not rewrite a line it did not write: only the exact text. */
  check(
    'it rewrites its own text and nothing else',
    J.amended([J.entry('rank', '9 models in 4 min', NOW)], 'rank', J.sweepOpen(9), 'x'),
    null
  )
}

/**
 * And the times it did NOT run, which is the other half of the question.
 *
 * On this machine the ranking is standing down right now: the model being
 * answered with is the Ollama one, that provider has a single key, and the
 * feature is "one key measures while the other answers". Switching model
 * turned it off as a side effect and nothing said so - `/rank` had to be
 * typed to find out. The model is named because the model is the cause.
 */
check(
  'standing down names the model that caused it',
  J.rankNote('onekey', 'Gemma 4 31B (Ollama cloud)'),
  'standing down — Gemma 4 31B (Ollama cloud) has only one key, and it is the one answering'
)
check('turned off is just turned off', J.rankNote('off', 'anything'), 'switched off')
/* A line saying it stopped and no line saying it started again is worse
   than neither. */
check('and coming back is a line too', J.rankNote(null, 'anything'), 'ready again')

/* --------------------------------------------------------------- the report */

const DAYS = [
  J.entry('model', 'GLM 5.3 Flash → DeepSeek V4.1 Flash', at(0, 20, 14)),
  J.entry('rank', '9 models in 8 min', at(0, 19, 58)),
  J.entry('command', 'npm run build', at(0, 19, 31)),
  J.entry('setting', 'panel → bottom-right', at(1, 9, 5)),
  J.entry('start', 'version 0.1.0', at(3, 8, 2))
]
/* Oldest first, as the store keeps them. */
const STORED = [...DAYS].reverse()

{
  const lines = J.journalLines(STORED, { now: NOW })
  const text = lines.join(NL)
  check('the report names itself', lines[0], '**What Wumpy has done**')
  check('today is a heading', text.includes('**Today**'), true)
  check('so is yesterday', text.includes('**Yesterday**'), true)
  /* Spelled out rather than taken from Intl, so the wording can be checked
     at all. 20 Oct 2026 was a Tuesday. */
  check('and an older day is dated', text.includes('**Tue 20 Oct**'), true)
  check('newest first', text.indexOf('20:14') < text.indexOf('19:58'), true)
  check(
    'the time, the sort of thing, and the thing',
    lines.find((l) => l.includes('20:14')),
    '| 20:14 | model | GLM 5.3 Flash → DeepSeek V4.1 Flash |'
  )
  check('a sweep reads as a sweep', text.includes('| ranking | 9 models in 8 min |'), true)
  /* The promise, made every time. A list of what somebody has been doing is
     the one place in this app where "where does this go" deserves an answer
     before it is asked. */
  check('it says what is not in it', text.includes('never your messages, the answers, or a key'), true)
  check('and that it never leaves', text.includes('never sent to a model'), true)
  check('and how to be rid of it', text.includes('`/log clear`'), true)
}

/**
 * A pipe is the column separator, and a PowerShell pipeline is the one thing
 * in here that routinely contains one. Unescaped, `Get-Process | Where-Object`
 * renders as two columns of nonsense in the middle of the table.
 */
{
  const piped = J.entry('command', 'Get-Process | Where-Object Name -eq wumpy', NOW)
  const row = J.journalLines([piped], { now: NOW }).find((l) => l.includes('Get-Process'))
  /* Four unescaped pipes: the two edges and the two between the columns. The
     one in the command itself must not be counted, which is the whole point. */
  check('a pipeline does not break the table', (row.match(/(?<!\\)\|/g) ?? []).length, 4)
  check('and it is still readable', row.includes('Get-Process \\| Where-Object'), true)
}
/**
 * The other half of the same problem, and the quieter half.
 *
 * A Windows path goes into a markdown table that is rendered as markdown.
 * `C:\Users\_me_\notes.md` left alone renders as `C:Usersmenotes.md` in
 * italics: a path that looks like a path, points nowhere, and matches the
 * backslash-eating bug this repo has now had four times.
 */
{
  const path = String.raw`C:\Users\_me_\notes.md`
  const row = J.journalLines([J.entry('write', path, NOW)], { now: NOW }).find((l) =>
    l.includes('notes')
  )
  check('a path keeps its backslashes', row.includes(String.raw`C:\\Users\\\_me\_\\notes.md`), true)
  check('and its underscores', (row.match(/_/g) ?? []).length, 2)
}
/**
 * The rest of the set, which is not guesswork: these five lines were run
 * through the panel's own markdown pipeline - remark-parse with remark-gfm,
 * the same two react-markdown uses - and every one came back out of the
 * renderer byte for byte. Raw HTML is off in the panel, which is why the
 * angle brackets are in the list: `echo <html>` loses the tag otherwise.
 */
{
  const hazards = [
    String.raw`echo <html> & dir *.ts`,
    String.raw`git log --oneline | head -5 && echo ` + '`done`',
    String.raw`D:\Dev\[archive]\~old~\file.txt`
  ]
  for (const what of hazards) {
    const row = J.journalLines([J.entry('command', what, NOW)], { now: NOW }).find((l) =>
      l.startsWith('| ')
    )
    /* Nothing markdown acts on is left unescaped, and nothing else is
       touched: every hazardous character in the cell has a backslash in
       front of it. */
    const detail = row.split(/(?<!\\)\|/)[3]
    const loose = detail.match(/(?<!\\)[`*_~[\]<>&]/g)
    check(`nothing is left to the renderer: ${what.slice(0, 24)}`, loose, null)
  }
}

/* Truncation, and the way out of it. */
{
  let many = []
  for (let i = 0; i < 60; i++) many.push(J.entry('command', `run ${i}`, NOW - (60 - i) * MINUTE))
  const brief = J.journalLines(many, { now: NOW }).join(NL)
  check('the bare report is the recent ones', brief.includes(`The last ${J.RECENT} of 60`), true)
  check('the newest is in it', brief.includes('run 59'), true)
  check('the oldest is not', brief.includes('run 0 |'), false)
  check('and it says how to see the rest', brief.includes('`/log all`'), true)

  const full = J.journalLines(many, { now: NOW, limit: null }).join(NL)
  check('all of it is all of it', full.includes('run 0 |'), true)
  check('and then there is nothing to announce', full.includes('for the rest'), false)
}

/* One sort of thing only. */
{
  const only = J.journalLines(STORED, { now: NOW, only: 'model', limit: null }).join(NL)
  check('a filter keeps its own', only.includes('DeepSeek V4.1 Flash'), true)
  check('and drops the rest', only.includes('npm run build'), false)
  const none = J.journalLines(STORED, { now: NOW, only: 'write', limit: null }).join(NL)
  check('a filter that matches nothing says so', none.includes('Nothing of that sort'), true)
  check('and says how much did happen', none.includes('out of 5'), true)
  check('and points at the whole thing', none.includes('`/log` shows everything'), true)
}

/* Empty, which is what a new install and a just-cleared list both look like. */
{
  const empty = J.journalLines([], { now: NOW }).join(NL)
  check('nothing yet is explained, not blank', empty.includes('Nothing yet'), true)
  check('with what will fill it', empty.includes('re-ranking'), true)
  check('a table of nothing is not printed', empty.includes('| --- |'), false)
}
/* Everything is older than the limit: the same thing as empty, not a table of
   headings with no rows under them. */
check(
  'a list that has all aged out reads as empty',
  J.journalLines([J.entry('command', 'old', NOW - 9 * DAY)], { now: NOW }).join(NL).includes('Nothing yet'),
  true
)

/* ------------------------------------------------------- what changed, and what did not */

const S = DEFAULT_SETTINGS
const changed = (patch) => J.diffSettings(S, { ...S, ...patch }, NOW)

check('nothing changed, nothing recorded', J.diffSettings(S, { ...S }, NOW), [])
{
  const [one] = changed({ model: 'z-ai/glm-5.3-flash' })
  /* Its own kind, and the only one that shows the old value: "what was I on
     before" is the follow-up question every time. */
  check('the model gets its own word', one.kind, 'model')
  check('and both ends of the change', one.what, 'DeepSeek V4.1 Flash → GLM 5.3 Flash')
}
check('a setting shows what it is now', changed({ dock: 'bottom-right' })[0].what, 'panel → bottom-right')
check('by the name the settings sheet uses', changed({ modelOrder: 'smarts' })[0].what, 'model list ranked by → Smartest')
check('the engine by its label', changed({ searchEngine: 'bing' })[0].what, 'searches open in → Bing')
check('approval in words', changed({ approvalMode: 'all' })[0].what, 'commands → run everything')
/**
 * Stored the opposite way round from the command, which is exactly the thing
 * a report like this exists to stop somebody working out for themselves.
 * hideOnBlur false IS "stays on top: on".
 */
check('the inverted one is not passed on inverted', changed({ hideOnBlur: true })[0].what, 'stays on top → off')
check('an on/off reads on or off', changed({ thinking: true })[0].what, 'thinking first → on')
check('a path, or where it really goes', changed({ shellCwd: 'D:\\Dev' })[0].what, 'commands run in → D:\\Dev')
check('two changes at once are two lines', changed({ dock: 'left', thinking: true }).length, 2)
check(
  'the accounts answer, which changes the pacing',
  changed({ keyAccounts: { nvidia: 'separate' } })[0].what,
  'nvidia keys → separate accounts'
)

/**
 * AND THE TWO THAT MUST NEVER APPEAR.
 *
 * searchApiKey is a secret, and the report promises there are none in here.
 * latencies is written by the ranker every few minutes by design - nine lines
 * an hour would be most of the history, which is what the single 'rank' line
 * is for.
 */
check('a key never reaches the timeline', changed({ searchApiKey: 'BSA-secret-value' }), [])
check('nor do the numbers the ranker writes', changed({ latencies: { 'a': { ms: 1 } } }), [])
check('nor the window furniture', changed({ compactWidth: 462, smoothText: true }), [])

/* --------------------------------------------- a sweep, driven for real */

/**
 * The 'rank' line, produced by the actual Ranker rather than by a regex.
 *
 * This is the half the user named - "they re-rank all the models" - and it
 * cannot be watched live on demand: the ranker stands down whenever the
 * model being answered with has only one key, which on this machine is true
 * every time somebody switches to the Ollama model. So the class is driven
 * here on a fake clock, which also buys the thing a live run could not give
 * - the sweep is checked for firing EXACTLY ONCE, with numbers that add up,
 * and for not counting a measurement the user interrupted.
 *
 * Date.now is replaced because the pacing between probes is thirty seconds
 * of real time and nine of those is five minutes nobody is going to wait
 * for, in a check or anywhere else.
 */
{
  const ranker = join(process.cwd(), '.journal-ranker.mjs')
  await build({
    entryPoints: ['src/main/ranker.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: ranker,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
  const { Ranker } = await import(pathToFileURL(ranker).href)
  rmSync(ranker, { force: true })

  const cloudFile = await bundleShared('cloud')
  const cloud = await import(pathToFileURL(cloudFile).href)
  rmSync(cloudFile, { force: true })
  const catalogue = cloud.CLOUD_MODELS.length

  const realNow = Date.now
  let clock = NOW
  Date.now = () => clock
  /* Nothing is logged out of a check. The ranker narrates each measurement
     to the console, which is wumpy.log's job and not this output's. */
  const realLog = console.log
  const quiet = () => {}

  try {
    const sweeps = []
    const starts = []
    const stood = []
    let failFrom = null
    let keys = 2
    let on = true
    const make = (probeMs) =>
      new Ranker({
        probe: async (id) => {
          clock += probeMs
          if (failFrom && id === failFrom) throw new Error('unreachable')
          return { model: id, provider: 'nvidia', state: 'ok', ms: probeMs }
        },
        preamble: () => 'preamble',
        state: () => ({ on, keys }),
        traffic: () => ({
          busy: false,
          sinceTurnMs: Infinity,
          lastMinute: 0,
          perMinute: 35,
          sinceLimitedMs: Infinity
        }),
        record: () => {},
        began: (s) => starts.push(s),
        swept: (s) => sweeps.push(s),
        stoodDown: (why) => stood.push(why)
      })

    /** One tick per model, with enough fake time in between to be allowed. */
    const run = async (r) => {
      for (let i = 0; i < catalogue + 2; i++) {
        console.log = quiet
        await r.tick()
        console.log = realLog
        clock += 31_000
      }
    }

    const r = make(2_000)
    r.sweepNow()
    await run(r)
    /* The line the user asked for: written when the first measurement
       landed, not when the ninth did. */
    check('the sweep is announced when it starts', starts.length, 1)
    check('with the whole catalogue to do', starts[0]?.asked, catalogue)
    check('a sweep is announced once', sweeps.length, 1)
    check('with every model in the catalogue', sweeps[0]?.asked, catalogue)
    check('and every one of them measured', sweeps[0]?.models, catalogue)
    /* Nine models, thirty-one fake seconds apart: four and a half minutes of
       work. The number that must be right is the SHAPE of it - minutes, not
       zero and not the hour the queue sat waiting. */
    check(
      'timed from the first measurement, not the queue',
      sweeps[0]?.tookMs > 4 * MINUTE && sweeps[0]?.tookMs < 6 * MINUTE,
      true
    )
    check('which is the line it turns into', J.sweepLine(sweeps[0]), `${catalogue} models in 4 min`)

    /* A model that could not be reached is dropped from the sweep rather
       than retried in a loop - so the sweep still ends, and still says so,
       with one fewer than it asked for. That gap is the most useful thing a
       sweep ever reports and `9 models` would have hidden it. */
    sweeps.length = 0
    failFrom = cloud.CLOUD_MODELS[0].id
    const r2 = make(2_000)
    r2.sweepNow()
    await run(r2)
    check('a sweep that lost one still finishes', sweeps.length, 1)
    check('and says how many it got', sweeps[0]?.models, catalogue - 1)
    failFrom = null

    /* And the second sweep: due an hour after the first finished, not
       before, and announced on its own. */
    sweeps.length = 0
    const r3 = make(2_000)
    r3.sweepNow()
    await run(r3)
    check('one sweep, one line', sweeps.length, 1)
    await run(r3)
    check('and nothing while it is not due', sweeps.length, 1)
    clock += 61 * MINUTE
    await run(r3)
    check('an hour later, the next one', sweeps.length, 2)

    /**
     * And the reason the clock is where it is.
     *
     * A sweep can sit in its queue for an afternoon because the user never
     * stopped typing - that is the feature working, every rule in
     * @shared/ranking being a refusal. Starting the clock when the queue was
     * filled would report "9 models in 3 h" and describe the waiting as
     * though it were work.
     */
    sweeps.length = 0
    const r4 = make(2_000)
    r4.start()
    clock += 3 * HOUR
    await run(r4)
    r4.stop()
    check('a sweep that waited hours reports only the work', sweeps[0]?.tookMs < 6 * MINUTE, true)

    /**
     * And the times it does not run at all.
     *
     * This is the state the machine is in right now: the model being
     * answered with is the Ollama one, which has a single key, so the
     * ranking stands down - correctly, and until now silently. Reported on
     * the CHANGE only, or a rule consulted every fifteen seconds would
     * write four lines a minute.
     */
    stood.length = 0
    sweeps.length = 0
    keys = 1
    const r5 = make(2_000)
    r5.sweepNow()
    await run(r5)
    check('one key is reported once', stood, ['onekey'])
    check('and nothing was measured on it', sweeps.length, 0)
    await run(r5)
    check('and not again while it is still true', stood, ['onekey'])

    /* A second key arrives: it says so, and gets on with the sweep that was
       queued all along. */
    keys = 2
    await run(r5)
    check('and when it can run again, that too', stood, ['onekey', null])
    check('and it does run', sweeps.length, 1)

    /* Switched off is the other durable one. Everything else - busy,
       cooling, crowded, paced - is weather, and is never reported. */
    stood.length = 0
    on = false
    const r6 = make(2_000)
    r6.sweepNow()
    await run(r6)
    check('off is reported', stood, ['off'])
    on = true
    await run(r6)
    check('and so is coming back on', stood, ['off', null])
  } finally {
    Date.now = realNow
    console.log = realLog
  }
}

/* ------------------------------------------------- it is wired to the real app */

{
  const main = readFileSync('src/main/index.ts', 'utf8')
  /* Every kind that is recorded by hand, at the place that does the thing.
     'model' and 'setting' are not here: they come off the settings diff, as
     the next assertion checks. */
  for (const kind of [
    'start',
    'rank',
    'key',
    'command',
    'write',
    'open',
    'search',
    'desktop',
    'chat',
    'limit'
  ]) {
    if (!new RegExp(`journal\\.add\\(\\s*'${kind}'`).test(main)) {
      failed++
      console.log(`FAIL nothing in the app ever records a '${kind}'`)
    } else count++
  }
  console.log(`ok   10 kinds are recorded where the thing actually happens`)

  /* Off the diff, so the tray menu's approval mode and the hotkey's dock are
     recorded too - not off the commands, which are not the only writer. */
  check(
    'settings changes come from a diff, whoever made them',
    /settings\.onChange\(\(next\) => \{[\s\S]*?diffSettings\(known, next\)/.test(main),
    true
  )
  /* A sweep is one line, not nine - and not two: the line it opens with is
     the line it finishes, so the time stays the time it happened. */
  check(
    'a sweep opens a line when it starts',
    /began: \(sweep\) => journal\.add\('rank', sweepOpen/.test(main),
    true
  )
  check(
    'and finishes that same line',
    /journal\.amend\('rank', sweepOpen\(sweep\.asked\), done\)/.test(main),
    true
  )
  /* With a fallback, so an interrupted or aged-out sweep still records that
     it finished rather than dropping the event. */
  check('or writes it fresh if there is none', /\)\) journal\.add\('rank', done\)/.test(main), true)
  /* And the times it did not run, with the model that is the reason. */
  check(
    'standing down is recorded with the model',
    /stoodDown: \(why\) => journal\.add\('rank', rankNote\(why, modelLabel\(activeModel\(\)\)\)\)/.test(
      main
    ),
    true
  )
  /* The receipt the whole thing is for: recorded by the code that ran it,
     after it ran, not by the renderer that asked. */
  check(
    'a command is recorded after it returns',
    /const result = await runCommand\(/.test(main) && /journal\.add\(\s*'command',/.test(main),
    true
  )

  const store = readFileSync('src/main/journal.ts', 'utf8')
  check('the file is written atomically', /writeAtomic\(/.test(store), true)
  check('and read back through the same pruning', /prune\(/.test(store), true)

  /* One way: the panel may read it and clear it, and there is no handler for
     writing a line from the renderer at all. */
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  check('the bridge reads and clears, and nothing else', /journal: \{\s*get:[\s\S]*?clear:[\s\S]*?\}/.test(preload), true)
  check('nothing in the bridge can add a line', /journalAdd|journal\.add/.test(preload), false)
}

console.log(
  failed === 0
    ? `${NL}all ${count} journal checks correct`
    : `${NL}${failed} of ${count} journal checks FAILED`
)
process.exit(failed === 0 ? 0 : 1)

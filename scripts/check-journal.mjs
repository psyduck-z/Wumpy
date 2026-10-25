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
 * every setting; both the count cap and the day rule are checked with real
 * entries, because disk.ts exists because of 38 MB of user data that nobody
 * chose. The day rule is the one the user asked for in those words - "only
 * keep logs from today" - and the three wrong ways to write it are all still
 * writable, so all three are checked: see startOfDay.
 *
 * AND IT MUST NOT HOLD WHAT IT PROMISES NOT TO. The report says, every time,
 * that there are no keys and no messages in here. That promise is only as good
 * as the settings diff ignoring searchApiKey, so that is checked rather than
 * commented.
 *
 * Run with: npm run check:journal
 */
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
/**
 * TODAY, AND NOTHING BEFORE IT.
 *
 * Asked for in those words: "only keep logs from today". It was seven days,
 * and the three ways of writing this rule wrongly are all still writable, so
 * all three are checked:
 *
 *   now - 24h          keeps last night. The entry below at yesterday 23:00
 *                      is three and a half hours old and must still go.
 *   now - now % DAY    is midnight in UTC, which is lunchtime or teatime
 *                      somewhere - and the clock the log prints is the one
 *                      on the taskbar.
 *   a fixed 24h step   is wrong on the two days a year the clocks move, when
 *                      the day is 23 hours or 25. See the year below.
 */
{
  const lastNight = J.entry('command', 'late last night', at(1, 23, 0))
  const thisMorning = J.entry('command', 'this morning', at(0, 8, 12))
  check('yesterday is not kept', J.prune([lastNight, thisMorning], NOW).length, 1)
  check('and the one kept is today', J.prune([lastNight, thisMorning], NOW)[0].what, 'this morning')
  check('adding one also prunes', J.keep([lastNight], thisMorning, 500, NOW).length, 1)
  /* Not a rolling day: that line is barely three hours old. */
  check('and it goes even three hours later', NOW - lastNight.at < DAY, true)

  /* Midnight itself belongs to the day that is starting, which is the one
     second where the two readings of the rule differ. */
  check('midnight is today', J.prune([J.entry('start', 'on the dot', at(0, 0, 0))], NOW).length, 1)
  check(
    'and the instant before it is not',
    J.prune([{ kind: 'start', what: 'just before', at: at(0, 0, 0) - 1 }], NOW).length,
    0
  )
  check('the cutoff is local midnight', J.startOfDay(NOW), new Date(2026, 9, 23).getTime())

  /**
   * Every day of a year, including whichever two this machine moves its
   * clocks on.
   *
   * The timezone is whatever the machine has - the point is that the answer
   * is the local date's own midnight on all 365 of them, which a subtraction
   * cannot be.
   */
  let wrong = 0
  for (let d = 0; d < 365; d++) {
    const noon = new Date(2026, 0, 1 + d, 12, 0, 0).getTime()
    const midnight = new Date(new Date(noon).getFullYear(), new Date(noon).getMonth(), new Date(noon).getDate()).getTime()
    if (J.startOfDay(noon) !== midnight) wrong++
  }
  check('and it is midnight on every day of the year', wrong, 0)
}
check('a nonsense timestamp is not kept', J.prune([{ kind: 'start', what: 'x' }], NOW).length, 0)
/* Nothing is dropped from the other end. A timestamp in the future is a
   clock that was put back after the line was written, and the event still
   happened - see dayHeading, which dates it honestly instead. */
check(
  'a line from a clock that was put back is kept',
  J.prune([J.entry('start', 'from the future', NOW + 3 * HOUR)], NOW).length,
  1
)

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
  'standing down — Gemma 4 31B (Ollama cloud) has one key'
)
check('turned off is just turned off', J.rankNote('off', 'anything'), 'switched off')
/* A line saying it stopped and no line saying it started again is worse
   than neither. */
check('and coming back is a line too', J.rankNote(null, 'anything'), 'ready again')

/* --------------------------------------------------------------- the report */

/* A day's worth, all of it today - which since "only keep logs from today"
   is every list the report will ever be handed. */
const TODAY = [
  J.entry('model', 'GLM 5.3 Flash → DeepSeek V4.1 Flash', at(0, 20, 14)),
  J.entry('rank', '9 models in 8 min', at(0, 19, 58)),
  J.entry('command', 'npm run build', at(0, 19, 31)),
  J.entry('setting', 'panel → bottom-right', at(0, 9, 5)),
  J.entry('start', 'version 0.1.0', at(0, 8, 2))
]
/* Oldest first, as the store keeps them. */
const STORED = [...TODAY].reverse()

{
  const lines = J.journalLines(STORED, { now: NOW })
  const text = lines.join(NL)
  check('the report names itself', lines[0], '**What Wumpy has done**')
  /**
   * Asked for: "don't make it a table, make it look more old style... more
   * basic. More like, not like a table style." So: no table anywhere in it,
   * and the day sections are a rule drawn across the block rather than a
   * heading in bold - "just make it hard, like it's a separate section".
   */
  check('nothing in it is a table', text.includes('| --- |'), false)
  check('today is a rule across the block', text.includes('─── Today ────'), true)
  /* One day kept is one section: the rule names the day and there is never
     a second one to scroll past. */
  const rules = lines.filter((l) => l.startsWith('───'))
  check('one day, one rule', rules.length, 1)
  check('newest first', text.indexOf('20:14') < text.indexOf('19:58'), true)
  check(
    'the time, the sort of thing, and the thing',
    lines.find((l) => l.includes('20:14')),
    '20:14 model    GLM 5.3 Flash → DeepSeek V4.1'
  )
  /* The columns line up, which is the whole of why it is monospace: every
     entry's detail starts in the same place, and so does every folded
     line's. */
  const bodies = lines.filter((l) => /^\d\d:\d\d /.test(l) || /^ {15}\S/.test(l))
  check(
    'every detail starts in the same column',
    new Set(bodies.map((l) => l.length - l.slice(15).length)).size,
    1
  )
  check('a sweep reads as a sweep', text.includes('19:58 ranking  9 models in 8 min'), true)
  /**
   * And nothing in the block reaches the edge of the panel.
   *
   * Reported with a screenshot of two horizontal scrollbars: "try to reduce
   * all scrolling that especially includes the bar, especially side to
   * side". The rule across each day was the widest thing in it.
   */
  const fenced = text.split('````')[1].split(NL).filter((l) => l.trim())
  check('no line is wider than the panel', Math.max(...fenced.map((l) => [...l].length)), 44)

  /**
   * And the block is fenced, once, with four backticks.
   *
   * The fence is what makes it a separate thing in the transcript rather
   * than text the conversation runs into - and four because the one thing a
   * fence cannot survive is a fence: a recorded command may contain three.
   */
  check('the listing is one fenced block', lines.filter((l) => l === '````').length, 2)
  check('opened before the first rule', lines.indexOf('````') < lines.findIndex((l) => l.startsWith('───')), true)
  {
    const sneaky = J.journalLines([J.entry('command', 'echo ```` stop', NOW)], { now: NOW })
    check('a command cannot end the block early', sneaky.filter((l) => l === '````').length, 2)
    check('and what it typed is still legible', sneaky.join(NL).includes("echo '''' stop"), true)
  }
  /* The promise, made every time. A list of what somebody has been doing is
     the one place in this app where "where does this go" deserves an answer
     before it is asked. */
  check('it says what is not in it', text.includes('what was done, never what was said'), true)
  check('and that it never leaves', text.includes('never sent to a model'), true)
  check('and how long it is kept', text.includes('Today only'), true)
  check('and how to be rid of it', text.includes('`/log clear`'), true)
  /* Nothing in the report still promises a week of it. */
  check('nothing claims seven days', /seven days|last week/i.test(text), false)
}

/**
 * THE DAY HEADING, which now has one case it uses and two it keeps.
 *
 * Only today is kept - see startOfDay - so 'Today' is what the rule says.
 * The other two are not dead code: the list is read at the moment a line is
 * added, and a line written at 23:59:59 can be printed at 00:00:01. The
 * heading then dates it instead of calling it today, and it is gone by the
 * next read.
 */
{
  check('today is today', J.dayHeading(at(0, 9, 0), NOW), 'Today')
  check('yesterday has its own word', J.dayHeading(at(1, 9, 0), NOW), 'Yesterday')
  /* Spelled out rather than taken from Intl, so the wording can be checked
     at all. 20 Oct 2026 was a Tuesday. */
  check('and anything else is dated', J.dayHeading(at(3, 8, 2), NOW), 'Tue 20 Oct')

  /**
   * And the one list that really does print two sections: a clock put back.
   *
   * The entry is stamped after midnight and the clock now says five to, so
   * prune keeps it (it is not from before today) and the heading dates it
   * rather than lying about it. This is also where the rules being the same
   * width is worth checking, which a single-section report cannot show.
   */
  const lateEvening = new Date(2026, 9, 22, 23, 55, 0).getTime()
  const twoDays = J.journalLines(
    [J.entry('command', 'before the clock moved', lateEvening - 10 * MINUTE), J.entry('start', 'after it', lateEvening + 10 * MINUTE)],
    { now: lateEvening }
  )
  const rules = twoDays.filter((l) => l.startsWith('───'))
  check('two days, two rules', rules.length, 2)
  check('all the same width', new Set(rules.map((r) => [...r].length)).size, 1)
  check('and the odd one is dated, not called today', rules.some((r) => r.includes('Fri 23 Oct')), true)
}

/**
 * VERBATIM, which is what the fence bought.
 *
 * These lines all used to need escaping, and each was a bug first: a
 * PowerShell pipeline split the row into extra columns, `C:\Users\_me_\x`
 * lost both underscores to emphasis and rendered as a path that points
 * nowhere, `echo <html>` lost the tag because raw HTML is off in the panel.
 * The table needed a rule for every one of them. A fence needs none, and a
 * log that prints something other than what happened is not a log - so the
 * assertion is equality, not the absence of damage.
 */
{
  const verbatim = [
    String.raw`Get-Process | Where-Object Name -eq wumpy`,
    String.raw`C:\Users\_me_\notes.md`,
    String.raw`echo <html> & dir *.ts`,
    String.raw`git log --oneline | head -5 && echo ` + '`done`',
    String.raw`D:\Dev\[archive]\~old~\file.txt`
  ]
  for (const what of verbatim) {
    const lines = J.journalLines([J.entry('command', what, NOW)], { now: NOW })
    /* The entry's own lines: the one that starts with a time, and any that
       picked it up again under the detail column. Joined back with the
       single space the folding broke it at. */
    const body = lines.filter((l) => /^\d\d:\d\d/.test(l) || /^ {15}\S/.test(l))
    const printed = body.map((l) => l.slice(15)).join(' ')
    check(`printed as it happened: ${what.slice(0, 26)}`, printed, what)
  }
}

/**
 * A long one folds under its own column rather than running off the side.
 *
 * A code block scrolls sideways and the panel is four hundred pixels wide,
 * so a line nobody can read the end of is a line nobody reads.
 */
{
  const long = J.entry(
    'command',
    'npm run typecheck -- --some-long-flag and another one after it',
    NOW
  )
  const lines = J.journalLines([long], { now: NOW }).filter((l) => /\S/.test(l))
  const body = lines.filter((l) => /^\d\d:\d\d/.test(l) || /^\s{15}\S/.test(l))
  check('it takes more than one line', body.length > 1, true)
  check('and the second starts under the first', body[1].search(/\S/), 15)
  /* Nothing is lost to the folding: the words are all still there, in
     order. */
  check(
    'with every word still in it',
    body.map((l) => l.trim()).join(' ').replace(/^\S+\s+\S+\s+/, ''),
    'npm run typecheck -- --some-long-flag and another one after it'
  )
  check('and no line is wider than the panel', Math.max(...body.map((l) => l.length)) <= 44, true)
}

/**
 * And the default answer does not fold itself.
 *
 * A fenced block past CODE_LINES is replaced by a "N lines" button, which
 * for the answer to `/log` would mean asking twice to see it. Measured
 * against the real constant rather than a number copied here, so RECENT and
 * the fold rule cannot drift apart silently.
 */
{
  const bulkFile = await bundleShared('bulk')
  const bulk = await import(pathToFileURL(bulkFile).href)
  rmSync(bulkFile, { force: true })
  /* A busy day: the newest RECENT of them, each a line, with day rules. */
  const busy = []
  for (let i = 0; i < 60; i++) {
    busy.push(J.entry('command', `npm run something-${i}`, NOW - i * 20 * MINUTE))
  }
  const fenced = J.journalLines(busy, { now: NOW })
    .join(NL)
    .split('````')[1]
  check('the bare report is not folded away', bulk.foldsCode(fenced), false)
  check('and it is close enough to the limit to matter', bulk.measure(fenced).lines > 15, true)
}

/* Truncation, and the way out of it. */
{
  let many = []
  for (let i = 0; i < 60; i++) many.push(J.entry('command', `run ${i}`, NOW - (60 - i) * MINUTE))
  const brief = J.journalLines(many, { now: NOW }).join(NL)
  check('the bare report is the recent ones', brief.includes(`The last ${J.RECENT} of 60`), true)
  check('the newest is in it', brief.includes('run 59'), true)
  check('the oldest is not', brief.includes('run 0'), false)
  check('and it says how to see the rest', brief.includes('`/log all`'), true)

  const full = J.journalLines(many, { now: NOW, limit: null }).join(NL)
  check('all of it is all of it', full.includes('run 0'), true)
  check('and then there is nothing to announce', full.includes('for the rest'), false)
}

/* One sort of thing only. */
{
  const only = J.journalLines(STORED, { now: NOW, only: 'model', limit: null }).join(NL)
  check('a filter keeps its own', only.includes('GLM 5.3 Flash → DeepSeek'), true)
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
/* Everything in it is from yesterday: the same thing as empty, not a day rule
   with no rows under it. This is what the first `/log` of the morning reads
   like on a machine that was busy all night. */
{
  const stale = J.journalLines(
    [J.entry('command', 'last thing last night', at(1, 23, 50))],
    { now: NOW }
  ).join(NL)
  check('a list that is all from yesterday reads as empty', stale.includes('Nothing yet'), true)
  check('and says when it starts again', stale.includes('starts again at midnight'), true)
  check('with no day rule over nothing', stale.includes('───'), false)
}

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

  /**
   * AND A `/log` ON SCREEN KEEPS UP WITH IT.
   *
   * Asked for: "when my logs is displayed, also make it auto update...
   * when it rechecks the models, also automatically add that in,
   * especially while I'm still looking at the logs". The report was a
   * snapshot of a file that changes, and the change worth watching - a
   * sweep finishing - happens with nobody typing.
   */
  check('every change is announced from one place', /this\.write\(\)\s*\n\s*this\.changed\?\.\(\)/.test(store), true)
  check('and the panel is what it tells', /journal = new JournalStore\(\(\) => panel\?\.send\(IPC\.journalChanged/.test(main), true)
  /* No payload: the page fetches only if it has something on screen to
     bring up to date, so an unwatched machine copies nothing across. */
  check('with nothing in the message', /IPC\.journalChanged, null\)/.test(main), true)

  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  check('the page listens', /window\.wumpy\.journal\.onChange\(/.test(app), true)
  /* The newest one only, and only while it is the last thing said: a block
     that has scrolled above an answer is part of what was said at the time,
     and rewriting it would be editing the conversation behind the reader. */
  check(
    'and only rewrites it while it is the last message',
    /shown\[shown\.length - 1\]\?\.id !== live\.id\) \{\s*\n\s*liveLog\.current = null/.test(app),
    true
  )
  check('the block is written as one that can be', /chat\.liveNote\(journalLines/.test(app), true)

  const bridge = readFileSync('src/preload/index.ts', 'utf8')
  check('the bridge carries the news one way', /onChange: \(cb: \(\) => void\) => on\(IPC\.journalChanged/.test(bridge), true)

  /* One way: the panel may read it and clear it, and there is no handler for
     writing a line from the renderer at all. */
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  check('the bridge reads and clears, and nothing else', /journal: \{\s*get:[\s\S]*?clear:[\s\S]*?\}/.test(preload), true)
  check('nothing in the bridge can add a line', /journalAdd|journal\.add/.test(preload), false)
}

/* ------------------------------------------- the store, told to a listener */

/**
 * The real JournalStore, in a temporary directory, saying what it did.
 *
 * Source assertions above prove the wiring is written; this proves it
 * fires - on a line added, on a sweep's line being finished, and on the
 * whole thing being forgotten. A `/log` that keeps up is exactly as good as
 * this callback.
 */
{
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-journal-'))
  const shim = join(dir, 'electron.mjs')
  writeFileSync(shim, `export const app = { getPath: () => ${JSON.stringify(dir)} }${NL}`)
  const built = join(process.cwd(), '.journal-store.mjs')
  await build({
    entryPoints: ['src/main/journal.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: built,
    logLevel: 'error',
    alias: { electron: shim, '@shared': 'src/shared' }
  })
  const { JournalStore } = await import(pathToFileURL(built).href)
  rmSync(built, { force: true })

  let told = 0
  const store = new JournalStore(() => (told += 1))
  check('nothing happens, nothing is said', told, 0)

  store.add('rank', J.sweepOpen(9))
  check('a line is announced', told, 1)
  check('and it is on the disk', JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')).entries.length, 1)

  /* The sweep finishing rewrites its own line, which is a change somebody
     watching should see: `measuring 9 models…` becoming `9 models in 8
     min` is the moment the hourly ranking reports in. */
  check('finishing the sweep line is a change', store.amend('rank', J.sweepOpen(9), '9 models in 8 min'), true)
  check('and it is announced too', told, 2)
  check('with nothing added', store.all().length, 1)
  check('and the line now reads as finished', store.all()[0].what, '9 models in 8 min')

  /* An amend that matches nothing changed nothing, so it says nothing. */
  check('a miss changes nothing', store.amend('rank', 'not in here', 'x'), false)
  check('and announces nothing', told, 2)

  /* A refusal folded into the one before it is not a change either. See
     QUIET_REPEATS: one turn against twenty keys is a dozen of the same
     fact, and a dozen redraws of the panel for it would be worse. */
  store.add('limit', 'NVIDIA: rate limited')
  store.add('limit', 'NVIDIA: rate limited')
  check('a folded repeat is not a second change', told, 3)

  store.clear()
  check('forgetting it is a change as well', told, 4)
  check('and there is nothing left', store.all().length, 0)

  /**
   * AND THE SWEEP THAT CROSSED MIDNIGHT.
   *
   * A sweep waits for quiet moments, so there can be an hour between its
   * first measurement and its last - which means on any night the machine is
   * on, one of them opens before midnight and finishes after it. Amending
   * yesterday's line in place would have put the finished sweep into a list
   * that is about to drop it, and `/log` would show a sweep that never ended.
   * So the store prunes before it looks, finds nothing, and sends the ranker
   * down its other path, which stamps the line today.
   */
  const yesterday = Date.now() - 24 * HOUR
  const before = told
  store.add('rank', J.sweepOpen(9), yesterday)
  check('a line stamped yesterday goes as soon as the list is read', store.all().length, 0)
  /* And the file stops holding it there and then, rather than waiting for
     the first thing that happens today. */
  check('the file does not hold it either', JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')).entries.length, 0)
  /* Written back, but not announced: whoever is reading is about to be
     handed the pruned list anyway. */
  check('and reading it is not announced', told, before + 1)
  check(
    'a sweep from yesterday is not finished in place',
    store.amend('rank', J.sweepOpen(9), '9 models in 8 min'),
    false
  )
  /* Which is the line the app writes when that comes back false. */
  store.add('rank', '9 models in 8 min')
  check('so the finished sweep is written fresh, today', store.all().length, 1)
  check('with the time it was written', J.dayHeading(store.all()[0].at), 'Today')

  rmSync(dir, { recursive: true, force: true })
}

console.log(
  failed === 0
    ? `${NL}all ${count} journal checks correct`
    : `${NL}${failed} of ${count} journal checks FAILED`
)
process.exit(failed === 0 ? 0 : 1)

import { sayModel } from './spokenpick'
import type { ApprovalMode, WumpySettings } from './types'
import { CLOUD_MODELS } from './cloud'
import { DEFAULT_ORDERING, isOrdering, orderingSpec } from './order'
import { DEFAULT_ENGINE, SEARCH_ENGINES, isSearchEngine } from './links'

/**
 * What Wumpy has done, with the time it happened.
 *
 * Asked for in these words: "add like a command like slash log, to basically
 * it has all the logs of what you've done. So then, for example, at like the
 * time, for example, they re-rank all the models, or for example, change
 * model at this time."
 *
 * Both examples are things the app did WITHOUT BEING ASKED, or at least
 * without being asked in the window the user was looking at. The hourly
 * ranking spends requests by itself; the model can change from the tray, from
 * a picker, or from a fallback when a key is rate limited. `/rank` says what
 * the ranking is doing NOW and `/settings` says what everything is set to
 * NOW, and between them there was no way to ask what changed while you were
 * not watching - which is the only question a timeline answers.
 *
 * TWO THINGS THIS IS NOT.
 *
 * It is not wumpy.log. That file is for debugging, it is overwritten from the
 * middle when it grows, and it is a wall of text with process detail in it.
 * This is a dozen words a line about things a person did or had done to them.
 *
 * And it is not renderer/ledger.ts, which records the same shape of thing for
 * the opposite reason: that one goes into the facts block so the MODEL cannot
 * claim it did not run something, and it is cleared with the chat. This one is
 * for the user, survives restarts, and is never sent to a model.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: no messages, no answers, and no key -
 * not even a masked one. A line names a command, a path, a host, a search, a
 * setting: the things the cards in the transcript already showed, which is
 * also the line the report draws out loud every time it prints. A search
 * query is on the near side of it because running a search IS the act and the
 * query is all there is to record about it; what somebody typed into the
 * composer is on the far side and never crosses. See WATCHED for the two
 * settings that are skipped for this reason.
 *
 * Pure, so the whole report can be checked against made-up entries without a
 * window, a disk or an hour to wait.
 */

export type EventKind =
  /** Wumpy started. The gaps between these explain gaps in the timeline. */
  | 'start'
  /** The model answering changed - the picker, or a migration. */
  | 'model'
  /** Anything else in the settings sheet. See WATCHED. */
  | 'setting'
  /** A background ranking sweep finished. */
  | 'rank'
  /** A key added, replaced or dropped. Positions and counts, never a key. */
  | 'key'
  /** A skill made, replaced or removed, by name. */
  | 'skill'
  /** A shell command actually ran. */
  | 'command'
  /** A file was written. */
  | 'write'
  /** A link was opened in the real browser. */
  | 'open'
  /** A web search was run. */
  | 'search'
  /** Clicks and keystrokes were played into another app. */
  | 'desktop'
  /** A conversation was deleted. */
  | 'chat'
  /** The provider refused for quota, and the pool moved. */
  | 'limit'

/**
 * One thing that happened.
 *
 * The same three fields as ledger.ts's Action, and for the same reason: the
 * code that did the thing writes the line, so there is nothing to reconcile
 * later between what happened and what it is called.
 */
export interface Entry {
  kind: EventKind
  /** Short, display-ready, and the real thing - the command, the path, the host. */
  what: string
  at: number
}

/** Longest a line may be. A command can be a paragraph; this is a log. */
export const MAX_DETAIL = 120

/**
 * How many lines are kept at all.
 *
 * A ceiling and not the usual limit - see startOfDay, which is what actually
 * decides what is in here. A day that reached a thousand lines would be a day
 * of nothing but Wumpy, and the cap exists for the case the day rule cannot
 * cover: something recording in a loop, which would otherwise grow the file
 * until midnight.
 *
 * Still a thousand rather than lower, because the cheap failure is a file of
 * 55 KB (a thousand lines, written without indentation) and the expensive one
 * is a busy morning losing its start. See disk.ts for why the size is worth a
 * thought at all: Wumpy's own records were 236 KB of a 38 MB user data
 * directory and the goal is to keep them that way.
 */
export const MAX_ENTRIES = 1000

/**
 * And how long: today, and no longer.
 *
 * Asked for in those words - "only keep logs from today". It was seven days,
 * and the shorter rule is the better one for what this actually answers.
 * Every question a timeline gets asked here is about the session somebody is
 * in: why is it on that model, when did the ranking last run, did that
 * command go twice. "What did I run on Tuesday" is not a question anyone has
 * asked it, and a week of answers to it is a week of a person's activity
 * sitting on the disk for no reason - see the file's own note on what is
 * deliberately not recorded. Keeping less is the same decision as not
 * writing the key.
 *
 * It also makes the report simpler than any wording could: one day, one
 * section, and `/log all` is a day rather than a week.
 *
 * MIDNIGHT, local, and calculated rather than subtracted. `now - 24h` is not
 * "since midnight" at any hour but midnight, and on the two days a year the
 * clocks move it is not a day either - the day is 23 hours or 25. setHours
 * on a local date is the one of these that is right on all three counts.
 */
export function startOfDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * How many the bare command shows. The rest are a word away with `/log all`.
 *
 * Sixteen rather than a round twenty-four, because of where the listing
 * ends up: a fenced block folds itself behind a "N lines" button past
 * CODE_LINES, which is 30. Sixteen entries, their day rules and the odd
 * folded detail come to the mid-twenties, so the answer to `/log` is
 * readable where it lands. `/log all` is allowed to fold - somebody who
 * asked for everything can open it.
 */
export const RECENT = 16

/** Tidies a detail into one line of at most MAX_DETAIL characters. */
export function detailOf(what: string): string {
  const text = String(what ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text
}

export function entry(kind: EventKind, what: string, at = Date.now()): Entry {
  return { kind, what: detailOf(what), at }
}

/**
 * Drops everything from before today. Oldest first, as stored.
 *
 * `>=` and not `>`: a line stamped exactly at midnight belongs to the day
 * that is starting, and that is the one second where the two readings differ.
 *
 * Nothing is dropped from the other end. A timestamp in the future is a
 * clock that was put back after the line was written, and the event still
 * happened - dayHeading will date it honestly rather than call it today.
 */
export function prune(entries: readonly Entry[], now = Date.now()): Entry[] {
  const cutoff = startOfDay(now)
  return entries.filter((e) => Number.isFinite(e?.at) && e.at >= cutoff)
}

/**
 * Where a repeat inside a minute is the same event rather than a new one.
 *
 * ONLY 'limit', and the reason is worth being explicit about. A 429 is a
 * state, not an act: one turn against twenty keys can produce a dozen
 * refusals in as many seconds, all of them the same fact - the account is at
 * its ceiling - and twelve lines would push a morning's real history off the
 * end of the file.
 *
 * 'command' is NOT in here and must not be. Running the same command twice is
 * two things happening, and a receipt that folds them is a receipt that
 * cannot answer "did you run it again?". That question is the entire reason
 * ledger.ts exists; see the uninstall it ran twice.
 */
export const QUIET_REPEATS: readonly EventKind[] = ['limit']

/** Two of the same within this long count as one, for QUIET_REPEATS only. */
export const SAME_AGAIN_MS = 60_000

export function isRepeat(
  entries: readonly Entry[],
  next: Entry,
  within = SAME_AGAIN_MS
): boolean {
  if (!QUIET_REPEATS.includes(next.kind)) return false
  const last = entries[entries.length - 1]
  if (!last || last.kind !== next.kind || last.what !== next.what) return false
  return next.at - last.at < within
}

/**
 * Where a line about the same setting REPLACES the one before it.
 *
 * isRepeat above is the same line twice. This is the same SETTING twice with
 * different values, which is what one key held down produces: Shift+Tab
 * cycles the approval mode three ways, so a few seconds of it wrote
 * "commands → run everything", "commands → read-only runs itself",
 * "commands → ask every time", over and over, and /log was a wall of a
 * setting being fiddled with. "no repeating annoying logs or
 * notifications."
 *
 * Only the line immediately before, and only within the minute. Beyond that
 * they are two decisions and the timeline should say so - changing a setting
 * at 21:20 and changing it back at 21:34 is exactly the thing somebody comes
 * here to find out. Inside a minute it is one person making up their mind,
 * and the honest record of that is where they landed.
 *
 * 'setting' only. A model line carries the value it changed FROM, so the
 * text before the arrow is not the subject and this rule would read it
 * wrongly; and a command, a write or a search are acts rather than states -
 * see QUIET_REPEATS for why running the same thing twice must always be two
 * lines.
 */
export function restates(
  entries: readonly Entry[],
  next: Entry,
  within = SAME_AGAIN_MS
): boolean {
  if (next.kind !== 'setting') return false
  const last = entries[entries.length - 1]
  if (!last || last.kind !== 'setting') return false
  if (next.at - last.at >= within) return false
  const subject = (e: Entry): string => e.what.split(' → ')[0]
  /* A line with no arrow in it has no subject to compare, and two of those
     are two different things that happened. */
  return subject(last) !== last.what ? subject(last) === subject(next) : false
}

/**
 * Adds one and keeps the file within both limits.
 *
 * Returns the whole list rather than mutating, so the store has one place
 * where what is on the disk is decided and this can be checked without one.
 */
export function keep(
  entries: readonly Entry[],
  next: Entry,
  max = MAX_ENTRIES,
  now = next.at
): Entry[] {
  if (isRepeat(entries, next)) return entries.slice()
  /* The line it supersedes goes, rather than the new one being dropped:
     suppressing it would leave the log claiming a setting is what it was
     two changes ago. See restates. */
  const base = restates(entries, next) ? entries.slice(0, -1) : entries
  const kept = prune([...base, next], now)
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

/** The word in the middle column: what sort of thing this was. */
export const WORD: Record<EventKind, string> = {
  start: 'started',
  model: 'model',
  setting: 'setting',
  /* 'ranking' rather than 'ranked', because the line is written when the
     sweep STARTS and finished in place when it ends. See sweepOpen. */
  rank: 'ranking',
  key: 'key',
  skill: 'skill',
  command: 'ran',
  write: 'wrote',
  open: 'opened',
  search: 'searched',
  desktop: 'desktop',
  chat: 'chat',
  limit: 'limited'
}

const KINDS = Object.keys(WORD) as EventKind[]

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && (KINDS as string[]).includes(value)
}

/**
 * `/log model`, `/log commands`, `/log ran` - whichever word came to mind.
 *
 * The kind, the column word and the obvious plurals all resolve, because the
 * user reading the table sees "ran" and the user thinking about it says
 * "commands", and asking them to remember which one the parser wanted is the
 * sort of thing that makes a filter not worth having.
 */
const ALSO: Record<string, EventKind> = {
  starts: 'start',
  started: 'start',
  launches: 'start',
  models: 'model',
  settings: 'setting',
  changes: 'setting',
  ranking: 'rank',
  ranked: 'rank',
  sweeps: 'rank',
  keys: 'key',
  commands: 'command',
  ran: 'command',
  run: 'command',
  shell: 'command',
  files: 'write',
  wrote: 'write',
  writes: 'write',
  links: 'open',
  opened: 'open',
  opens: 'open',
  searches: 'search',
  searched: 'search',
  clicks: 'desktop',
  steps: 'desktop',
  chats: 'chat',
  deleted: 'chat',
  limits: 'limit',
  limited: 'limit',
  quota: 'limit'
}

export function readKind(word: string): EventKind | null {
  const w = String(word ?? '')
    .trim()
    .toLowerCase()
  if (!w) return null
  if (isEventKind(w)) return w
  return ALSO[w] ?? null
}

/** HH:MM, local, 24-hour. The same clock the user's taskbar is showing. */
export function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Which calendar day, local, for grouping. */
function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/**
 * The heading above a day's rows.
 *
 * Spelled out rather than taken from Intl: a report that reads differently
 * depending on the machine's locale is a report whose wording cannot be
 * checked, and barely any day but today ever appears here.
 *
 * Barely, rather than never, which is why this still has all three cases in
 * it. The list only holds today - see startOfDay - but it is read at the
 * moment a line was added, and a line written at 23:59:59 can be printed at
 * 00:00:01. The heading then says the day it happened rather than claiming it
 * was today, and the stale line is gone by the next read.
 */
export function dayHeading(at: number, now = Date.now()): string {
  if (dayOf(at) === dayOf(now)) return 'Today'
  if (dayOf(at) === dayOf(now - 24 * 60 * 60 * 1000)) return 'Yesterday'
  const d = new Date(at)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/**
 * The fence the whole listing sits in, and why it is four backticks.
 *
 * Asked for: "don't make it a table, make it look more old style, like, you
 * know, more basic. More like, you know, not like a table style." A log is
 * one of the oldest formats there is - a time, a word, a thing - and a
 * markdown table with its rules and header separators is the opposite of
 * that.
 *
 * It also settles something a table could only paper over. Every line in
 * here is machine text: a command, a Windows path, a search somebody typed.
 * In a table cell a PIPE splits the row, so `Get-Process | Where-Object`
 * became three columns of nonsense; `C:\Users\_me_\x` lost both underscores
 * to emphasis and rendered as a path that points nowhere; `echo <html>`
 * lost the tag altogether, because the panel renders markdown with raw HTML
 * off. Each of those needed escaping, and escaping is a thing that can be
 * got wrong silently - this repo has had that bug four times. Inside a
 * fence nothing is interpreted at all, so the log can do what a log should
 * and print what happened, verbatim.
 *
 * FOUR backticks, because the one thing a fence cannot survive is a fence.
 * A recorded command may contain three of them, and three would end the
 * block there and spill the rest of the log into the page as markdown.
 */
const FENCE = '````'

/**
 * A detail that cannot end the block it is in.
 *
 * The only change made to a line, and it is for the one sequence that could
 * escape: four or more backticks. Anything else is left exactly as it was
 * recorded, which is the whole point of the fence.
 */
function safe(what: string): string {
  return what.replace(/`{4,}/g, (run) => "'".repeat(run.length))
}

/**
 * How wide the whole listing is allowed to be, in characters.
 *
 * Measured off the panel rather than chosen: at the default width the block
 * has about 337px inside its padding, and the mono face it is set in runs
 * close to 7px a character - about 48. Forty-four leaves room for the panel
 * to be a little narrower than the default without a single line reaching
 * the edge.
 *
 * Reported with a screenshot of two horizontal scrollbars: "try to reduce
 * all scrolling that especially includes the bar, especially side to side".
 * The rule across each day was 52 characters, which is what was hanging off
 * the right of the block. The CSS now wraps rather than scrolls, so a line
 * over this is untidy instead of unreachable - but untidy is still worth
 * not having.
 */
const LINE = 44

/** Where a folded detail picks up again: under the detail, not the time. */
const INDENT = 15

/** How wide a detail may be before it is folded onto the next line. */
const WIDTH = LINE - INDENT

/**
 * One entry, as the lines it occupies.
 *
 * Folded rather than left to run off the side. A code block scrolls
 * sideways and the panel is four hundred pixels wide, so a long command
 * would be a line nobody reads the end of; broken at a space with a hanging
 * indent it reads like `ps` output, which is the oldest style there is.
 */
function entryLines(e: Entry, times = 1): string[] {
  /* Nine, not eight: the longest word is `searched`, and padding to its own
     length leaves no gap at all - "searchedelectron 44 release notes" is
     what that looks like. The head is then exactly INDENT wide, which is
     what a folded line lines up under. */
  const head = `${clock(e.at)} ${WORD[e.kind].padEnd(9)}`
  const out: string[] = []
  let line = ''
  /* "last message repeated 4 times", which is how a log has said this for
     fifty years - see collapsing in journalLines for why it is honest. */
  const detail = times > 1 ? `${safe(e.what)} ×${times}` : safe(e.what)
  for (const word of detail.split(' ')) {
    if (!line) line = word
    else if (`${line} ${word}`.length <= WIDTH) line = `${line} ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out.map((text, i) => (i === 0 ? `${head}${text}` : `${' '.repeat(INDENT)}${text}`))
}

/**
 * The rule above a day's entries.
 *
 * Asked for in the same breath as the plainer format: "just make it hard,
 * like it's a separate section". A bold heading between two tables was a
 * change of weight; this is a line drawn across the block, which is the
 * thing an eye actually stops at.
 */
function rule(heading: string): string {
  const head = `─── ${heading} `
  return `${head}${'─'.repeat(Math.max(3, LINE - head.length))}`
}

export interface JournalView {
  now?: number
  /** How many to show. Null means everything kept. */
  limit?: number | null
  /** One sort of thing only. */
  only?: EventKind | null
}

/**
 * The whole report, as `/log` prints it.
 *
 * Newest first, grouped by day, because "when" is the question and a
 * timeline that starts at breakfast is one somebody has to scroll to reach
 * the thing they just did.
 *
 * Grouped by day although only today is kept, which costs one line and a
 * loop: the rule names the day, and the one case where the grouping does
 * real work is the line that crossed midnight - see dayHeading.
 */
export function journalLines(entries: readonly Entry[], view: JournalView = {}): string[] {
  const now = view.now ?? Date.now()
  const only = view.only ?? null
  const limit = view.limit === undefined ? RECENT : view.limit

  const head = '**What Wumpy has done**'
  const kept = prune(entries, now)
  if (!kept.length) {
    return [
      head,
      '',
      'Nothing yet today. This fills in as things happen — the model ' +
        'changing, a command running, the background re-ranking finishing a sweep.',
      '',
      '_Nothing is sent anywhere: it is a list on this machine, and it ' +
        'starts again at midnight._'
    ]
  }

  const matching = only ? kept.filter((e) => e.kind === only) : kept
  if (!matching.length) {
    return [
      head,
      '',
      `Nothing of that sort today, out of ${kept.length} ` +
        'things that did happen.',
      '',
      '`/log` shows everything.'
    ]
  }

  /* The newest `limit`, then reversed: slicing from the end keeps the recent
     ones, which is the opposite of what reading the first page would give. */
  const shown = (limit === null ? matching.slice() : matching.slice(-limit)).reverse()

  /*
   * One block, with the days as sections inside it.
   *
   * The fence is opened once rather than per day, so the whole listing is a
   * single thing in the transcript with a hard edge at each end - which is
   * the other half of what was asked for: a log that cannot be mistaken for
   * the conversation carrying on around it.
   */
  /*
   * Grouped by day, and a run of the same thing collapsed into one line.
   *
   * "Try to reduce all scrolling." The screenshot that came with it had
   * `desktop 1 step` four times and `one conversation deleted` twice, one
   * under the other, which is four lines saying what one line and a count
   * say better - and the count is what keeps it honest, the same bargain
   * `last message repeated 4 times` has always made. Only a RUN of them,
   * and only inside one day, so the sequence is never reordered and nothing
   * that happened between two of them is hidden behind either.
   */
  const sections: Array<{ heading: string; rows: Array<{ e: Entry; times: number }> }> = []
  for (const e of shown) {
    const heading = dayHeading(e.at, now)
    let section = sections[sections.length - 1]
    if (!section || section.heading !== heading) {
      section = { heading, rows: [] }
      sections.push(section)
    }
    const last = section.rows[section.rows.length - 1]
    if (last && last.e.kind === e.kind && last.e.what === e.what) last.times += 1
    else section.rows.push({ e, times: 1 })
  }

  const lines = [head, '', FENCE]
  for (const [i, section] of sections.entries()) {
    /* A blank line before every section but the first, so the rule has air
       above it and the block does not open on one. */
    if (i > 0) lines.push('')
    lines.push(rule(section.heading))
    for (const row of section.rows) lines.push(...entryLines(row.e, row.times))
  }
  lines.push(FENCE, '')
  if (shown.length < matching.length) {
    lines.push(
      `_The last ${shown.length} of ${matching.length}, newest first. ` +
        '`/log all` for the rest._'
    )
  }
  /* Said every time, because a list of what somebody has been doing is the
     one feature in this app where "where does this go?" deserves an answer
     before it is asked. */
  /* Two lines of footer under a block this size was most of a panel, so it
     says the same two things in a third of the words: where it lives, and
     that it holds what was DONE and not what was said. */
  lines.push(
    '_Today only, on this machine, never sent to a model: what was done, ' +
      'never what was said. `/log clear` forgets it now._'
  )
  return lines
}

/** How long something took, in the units a person would say it in. */
export function took(ms: number): string {
  /* "8 models in 498599 h": the clock read 1970 for a moment after this
     MacBook woke, and the sweep's start was taken then. A sweep is minutes;
     past a day it is a clock that moved, and says nothing. */
  if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) return ''
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.round(ms / 60_000)
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

/** 19:55 as it is said: "7:55 pm". */
function saidClock(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** What one line of the history says, as a clause. */
function saidEntry(e: Entry, times: number): string {
  const what = e.what.replace(/\s*→\s*/g, ' to ')
  const body =
    e.kind === 'model'
      ? `the model went from ${e.what.split(/\s*→\s*/).map(sayModel).join(' to ')}`
      : e.kind === 'start'
        ? 'Wumpy started'
        : e.kind === 'command'
          ? `it ran ${what}`
          : e.kind === 'write'
            ? `it wrote ${what}`
            : e.kind === 'open'
              ? `it opened ${what}`
              : e.kind === 'search'
                ? `it searched for ${what}`
                : e.kind === 'skill'
                  ? `the skill ${what}`
                  : e.kind === 'desktop'
                    ? `it worked another app, ${what}`
                    : what
  return times > 1 ? `${body}, ${COUNT_WORDS[times] ?? times} times` : body
}

/**
 * `/log`, through the earbuds. The panel's listing is a block of columns,
 * and the voice reads prose: what came out of "slash log" was "What Wumpy
 * has done. Today only, on this machine..." - the block itself skipped
 * whole. So the same history, said: the newest few things, then the
 * hourly ranking as one sentence, since ten of those read out one by one
 * would be all anybody heard.
 */
export function journalSpeech(entries: readonly Entry[], view: JournalView = {}): string {
  const now = view.now ?? Date.now()
  const kept = prune(entries, now).filter((e) => !view.only || e.kind === view.only)
  if (!kept.length) return view.only ? 'Nothing of that sort today.' : 'Nothing yet today.'
  const ranks = kept.filter((e) => e.kind === 'rank')
  const rest = view.only === 'rank' ? [] : kept.filter((e) => e.kind !== 'rank')
  /* A run of the same thing is one thing done several times. */
  const runs: Array<{ e: Entry; times: number }> = []
  for (const e of [...rest].reverse()) {
    const last = runs.at(-1)
    if (last && last.e.kind === e.kind && last.e.what === e.what) last.times++
    else runs.push({ e, times: 1 })
  }
  const SAID = 5
  const parts = runs.slice(0, SAID).map((r) => `At ${saidClock(r.e.at)}, ${saidEntry(r.e, r.times)}.`)
  if (runs.length > SAID) parts.push(`And ${runs.length - SAID} more before that, on the screen.`)
  if (ranks.length) {
    const last = ranks[ranks.length - 1]
    parts.push(
      ranks.length === 1
        ? `The models were ranked once, at ${saidClock(last.at)}.`
        : `The models were ranked ${COUNT_WORDS[ranks.length] ?? ranks.length} times, the last at ${saidClock(last.at)}.`
    )
  }
  return parts.join(' ')
}

/**
 * A sweep that has started, which is the line that answers the question.
 *
 * Asked for after the first version: "also log when the auto rerank
 * happened". It recorded the sweep when it FINISHED, which is a different
 * time and sometimes no time at all - a sweep waits for quiet moments, so
 * it can be an hour between the first measurement and the last, and a
 * restart in the middle means the whole thing left no trace. The user had
 * been told the ranking runs hourly and `/log` had nothing to show for it.
 *
 * So this is written when the first measurement lands, at the moment it
 * happened, and `amended` turns it into the finished line in place when the
 * sweep ends. One line per sweep, stamped when the sweep began.
 */
export function sweepOpen(asked: number): string {
  return `measuring ${asked} model${asked === 1 ? '' : 's'}…`
}

/**
 * A finished ranking sweep, in one line.
 *
 * "9 models in 8 min" when everything answered; "7 of 9 models" when it did
 * not, because a model that could not be reached is the most interesting
 * thing a sweep ever finds and a bare "9 models" would have hidden it.
 *
 * The duration is measured from the first measurement rather than from when
 * the sweep was queued - see Ranker.begin. A sweep that waited four hours
 * for a quiet moment did its job, and saying "in 4 h" would describe the
 * waiting as though it were work.
 */
export function sweepLine(sweep: { models: number; asked: number; tookMs: number }): string {
  const count =
    sweep.models === sweep.asked
      ? `${sweep.models} model${sweep.models === 1 ? '' : 's'}`
      : `${sweep.models} of ${sweep.asked} models`
  const long = took(sweep.tookMs)
  return long ? `${count} in ${long}` : count
}

/**
 * Why the ranking is not running, when the reason will not clear by itself.
 *
 * The second half of "log when the auto rerank happened" is the times it
 * did not. On this machine it is standing down right now and the only way
 * to find that out is to type `/rank`: the model being answered with is the
 * Ollama one, that provider has a single key, and the whole feature is "one
 * key measures while the other answers". Switching model turned the ranking
 * off as a side effect, hours before anybody wondered why nothing had been
 * measured.
 *
 * `null` is the other direction - it can run again - because a line saying
 * it stopped and no line saying it started again is worse than neither.
 *
 * The model is named because the model is the cause and nothing about the
 * ranking says so.
 */
export function rankNote(why: 'off' | 'onekey' | null, model: string): string {
  if (why === null) return 'ready again'
  if (why === 'off') return 'switched off'
  /* Short, because it is a log line and `/rank` is where the explanation
     lives. The model is named because the model is the cause and nothing
     about the ranking says so. */
  return `standing down — ${model} has one key`
}

/**
 * The newest line of this kind reading `from`, rewritten to `to`.
 *
 * Null when there is no such line, so the caller can write a fresh one
 * rather than lose the event.
 *
 * THE ONE PLACE ANYTHING IN HERE IS REWRITTEN, and the limits are the
 * point: the time is kept, the kind is kept, and the only text it will
 * replace is text this module wrote itself - an open sweep's own line,
 * becoming the same sweep's finished line. A sweep is one event and it has
 * one time, the time it started; recording it twice would be two lines
 * saying one thing, and at a sweep an hour that is most of a day's
 * history.
 *
 * Nothing a person or a model did is ever amended. A command that ran is
 * written once, by the code that ran it, and stays as written - see
 * QUIET_REPEATS for the same rule from the other side.
 */
export function amended(
  entries: readonly Entry[],
  kind: EventKind,
  from: string,
  to: string
): Entry[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== kind || e.what !== from) continue
    const next = entries.slice()
    next[i] = { ...e, what: detailOf(to) }
    return next
  }
  return null
}

/* ------------------------------------------------------ what changed in the settings */

/** The three approval modes, in fewer words than the settings sheet uses. */
export const APPROVAL_SHORT: Record<ApprovalMode, string> = {
  manual: 'ask every time',
  auto: 'read-only runs itself',
  all: 'run everything'
}

const onOff = (on: boolean): string => (on ? 'on' : 'off')

/** The label the picker shows for a model id, or the id when it is not ours. */
export function modelLabel(id: string): string {
  return CLOUD_MODELS.find((m) => m.id === id)?.label ?? id
}

/**
 * The settings worth a line, and how each one reads.
 *
 * `what` matches the wording in the settings sheet on purpose - two reports
 * calling the same setting different names is how somebody ends up believing
 * there are two settings.
 *
 * WHAT IS NOT HERE, and why:
 *
 *   searchApiKey    a secret. Nothing secret is written to this file, not
 *                   even the fact that one changed length.
 *   latencies       the ranker writes it every few minutes by design. That
 *                   is what a 'rank' line is for, and nine 'setting' lines
 *                   an hour would bury everything else.
 *   widths, hotkeys, maxTurnMs, smoothText, movedOffGoogle
 *                   furniture and internals. A log of what somebody did is
 *                   not improved by "compact width → 462".
 */
const WATCHED: ReadonlyArray<{
  key: keyof WumpySettings
  /** The words the settings sheet uses. */
  what: string
  /** What the value reads as, taken off a whole settings object. */
  show: (s: WumpySettings) => string
  /** 'setting' unless the change deserves its own word in the table. */
  kind?: EventKind
}> = [
  {
    key: 'model',
    what: 'answering with',
    show: (s) => modelLabel(s.model),
    /* Its own kind because it is one of the two things the user named
       wanting to look up, and because it is the setting every other answer
       depends on. A turn that was answered by a SIBLING model - the
       rate-limit fallback - does not change this and is not a line here;
       the reply says so at the time and the 'limit' line records why. */
    kind: 'model'
  },
  {
    key: 'modelOrder',
    what: 'model list ranked by',
    show: (s) => orderingSpec(isOrdering(s.modelOrder) ? s.modelOrder : DEFAULT_ORDERING).label
  },
  {
    key: 'searchEngine',
    what: 'searches open in',
    show: (s) =>
      SEARCH_ENGINES[isSearchEngine(s.searchEngine) ? s.searchEngine : DEFAULT_ENGINE].label
  },
  { key: 'approvalMode', what: 'commands', show: (s) => APPROVAL_SHORT[s.approvalMode] },
  { key: 'dock', what: 'panel', show: (s) => s.dock },
  /* Stored the opposite way round from the command, which is exactly the
     thing a report like this must not pass on. See the settings sheet. */
  { key: 'hideOnBlur', what: 'stays on top', show: (s) => onOff(!s.hideOnBlur) },
  { key: 'thinking', what: 'thinking first', show: (s) => onOff(s.thinking) },
  { key: 'showReasoning', what: 'reasoning shown', show: (s) => onOff(s.showReasoning) },
  { key: 'voiceEnabled', what: 'dictation', show: (s) => onOff(s.voiceEnabled) },
  { key: 'voicePolish', what: 'dictation tidied up', show: (s) => onOff(s.voicePolish) },
  {
    key: 'voiceAutoStop',
    what: 'dictation stops at a pause',
    show: (s) => onOff(s.voiceAutoStop)
  },
  {
    key: 'leanPrompt',
    what: 'instructions',
    show: (s) => (s.leanPrompt ? 'short form' : 'full')
  },
  { key: 'autoRank', what: 're-ranking every 30 minutes', show: (s) => onOff(s.autoRank) },
  { key: 'shellEnabled', what: 'running commands', show: (s) => onOff(s.shellEnabled) },
  {
    key: 'confirmRisky',
    what: 'risky commands still ask',
    show: (s) => onOff(s.confirmRisky)
  },
  { key: 'searchEnabled', what: 'web search', show: (s) => onOff(s.searchEnabled) },
  { key: 'browserEnabled', what: 'opening pages', show: (s) => onOff(s.browserEnabled) },
  { key: 'screenEnabled', what: 'screenshots', show: (s) => onOff(s.screenEnabled) },
  { key: 'apiFallback', what: 'another model when limited', show: (s) => onOff(s.apiFallback) },
  { key: 'autoSave', what: 'chats saved', show: (s) => onOff(s.autoSave) },
  { key: 'autoCompact', what: 'long chats summarised', show: (s) => onOff(s.autoCompact) },
  { key: 'launchAtLogin', what: 'starts with Windows', show: (s) => onOff(s.launchAtLogin) },
  {
    key: 'shellCwd',
    what: 'commands run in',
    show: (s) => s.shellCwd || 'your home folder'
  }
]

/**
 * What changed between two settings objects, as lines for the journal.
 *
 * Driven off a diff rather than off the commands, because the commands are
 * not the only writer. The tray menu sets the approval mode with no window
 * open; the panel patches the dock when the hotkey moves it; the Google
 * migration changed the model on one boot and told nobody. A journal built
 * from `/model` and friends would have been silent for exactly the changes
 * nobody saw happen.
 */
export function diffSettings(
  before: WumpySettings,
  after: WumpySettings,
  at = Date.now()
): Entry[] {
  const out: Entry[] = []
  for (const row of WATCHED) {
    if (before[row.key] === after[row.key]) continue
    const kind = row.kind ?? 'setting'
    out.push(
      entry(
        kind,
        /* The old value too, for the model: "what was I on before?" is the
           follow-up question every time, and the answer is otherwise
           further down the list or off the end of it. Settings show the new
           value alone, which keeps the cell short enough to read in a
           panel. */
        kind === 'model'
          ? `${row.show(before)} → ${row.show(after)}`
          : `${row.what} → ${row.show(after)}`,
        at
      )
    )
  }

  return out
}

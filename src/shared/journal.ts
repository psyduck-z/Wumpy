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
 * Enough for a busy week and small enough that the file stays tens of
 * kilobytes - see disk.ts for why that matters: Wumpy's own records were
 * 236 KB of a 38 MB user data directory and the goal is to keep them that
 * way. A thousand lines written without indentation is about 55 KB.
 *
 * The number has to be a week's worth of a BUSY day rather than an average
 * one, because the ranking alone can be two dozen: a sweep an hour for as
 * long as the machine is on. That is also why a sweep is one line and not
 * two - see amended.
 */
export const MAX_ENTRIES = 1000

/**
 * And how long.
 *
 * Seven days, because this is a record of what somebody did on their own
 * machine and it has no business outliving the question it answers. The same
 * reasoning as usage.ts keeping only today, one step less strict: "when did
 * the model change?" is reasonably asked about last Tuesday, and "what did I
 * run in March" is not a question this exists for.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

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

/** Drops what is older than MAX_AGE_MS. Oldest first, as stored. */
export function prune(entries: readonly Entry[], now = Date.now()): Entry[] {
  const cutoff = now - MAX_AGE_MS
  return entries.filter((e) => Number.isFinite(e?.at) && e.at > cutoff)
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
  const kept = prune([...entries, next], now)
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
 * checked, and only a week of days ever appears here.
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

/** How wide a detail may be before it is folded onto the next line. */
const WIDTH = 40

/** Where a folded detail picks up again: under the detail, not the time. */
const INDENT = 16

/**
 * One entry, as the lines it occupies.
 *
 * Folded rather than left to run off the side. A code block scrolls
 * sideways and the panel is four hundred pixels wide, so a long command
 * would be a line nobody reads the end of; broken at a space with a hanging
 * indent it reads like `ps` output, which is the oldest style there is.
 */
function entryLines(e: Entry): string[] {
  /* Nine, not eight: the longest word is `searched`, and padding to its own
     length leaves no gap at all - "searchedelectron 44 release notes" is
     what that looks like. The head is then exactly INDENT wide, which is
     what a folded line lines up under. */
  const head = `${clock(e.at)}  ${WORD[e.kind].padEnd(9)}`
  const out: string[] = []
  let line = ''
  for (const word of safe(e.what).split(' ')) {
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
  return `${head}${'─'.repeat(Math.max(3, 52 - head.length))}`
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
 * timeline that starts a week ago is one somebody has to scroll to reach the
 * thing they just did.
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
      'Nothing yet. This fills in as things happen — the model changing, a ' +
        'command running, the hourly re-ranking finishing a sweep.',
      '',
      '_Nothing is sent anywhere: it is a list on this machine, kept for ' +
        'seven days._'
    ]
  }

  const matching = only ? kept.filter((e) => e.kind === only) : kept
  if (!matching.length) {
    return [
      head,
      '',
      `Nothing of that sort in the last seven days, out of ${kept.length} ` +
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
  const lines = [head, '', FENCE]
  let day = ''
  for (const e of shown) {
    const heading = dayHeading(e.at, now)
    if (heading !== day) {
      /* A blank line before every section but the first, so the rule has
         air above it and the block does not open on one. */
      if (day) lines.push('')
      day = heading
      lines.push(rule(heading))
    }
    lines.push(...entryLines(e))
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
  lines.push(
    '_Seven days, on this machine, never sent to a model: what was run, ' +
      'written, opened or changed — never your messages, the answers, or a ' +
      'key. `/log clear` forgets it._'
  )
  return lines
}

/** How long something took, in the units a person would say it in. */
export function took(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.round(ms / 60_000)
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
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
 * saying one thing, and at a sweep an hour that is most of a week's
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
  { key: 'autoRank', what: 'hourly re-ranking', show: (s) => onOff(s.autoRank) },
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

  /* Separately, because it is a map and not a value: one line per provider
     whose answer changed. It is worth a line - it doubles the pace and
     stops one account's refusal standing the other down. See keyAccounts. */
  const providers = new Set([
    ...Object.keys(before.keyAccounts ?? {}),
    ...Object.keys(after.keyAccounts ?? {})
  ])
  for (const p of [...providers].sort()) {
    const was = before.keyAccounts?.[p as keyof typeof before.keyAccounts] ?? 'shared'
    const now = after.keyAccounts?.[p as keyof typeof after.keyAccounts] ?? 'shared'
    if (was !== now) out.push(entry('setting', `${p} keys → ${now} accounts`, at))
  }

  return out
}

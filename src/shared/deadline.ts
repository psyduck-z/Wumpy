/**
 * "Do not continue past 10:30."
 *
 * Said to a person, that sets a time. Said to Wumpy it used to set nothing:
 * the model read it, agreed, and had no clock to keep it with - it does not
 * know what time it is, and nothing woke it at 10:30 to say so. So the time is
 * read here, out of what the user said, and Wumpy keeps it: it says the time
 * back, and when it comes, it stops the answer, the agents and every
 * automatic hand-back, and says it has.
 *
 * Only a time said as a limit on the work. "The meeting is at 10:30" is a
 * fact, and "set a timer for five minutes" is a different job; both are left
 * alone. The forms that count:
 *
 *   do not continue / go / work past 10:30     stop at 10:30, stop by 10:30pm
 *   finish by 10:30, wrap up by 22:00          keep crunching until 10:30
 *   stop after two hours, stop in 20 minutes   keep going for half an hour
 *   no more than 30 minutes                    a time limit of an hour
 *
 * A clock time without am or pm means the next time the clock reads it: at
 * four in the afternoon, "10:30" is 10:30 tonight, not tomorrow morning.
 *
 * Pure, so it can be checked without an app: scripts/check-deadline.mjs.
 */

export type DeadlineHeard =
  | { kind: 'at'; at: number; said: string }
  | { kind: 'clear'; said: string }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** Further off than this is not a limit on what is being done now. */
const LONGEST = 24 * HOUR

/* ------------------------------------------------------------ clock times */

/** "10:30", "10.30", "10:30pm", "10 pm", "10 o'clock", "22:00". */
const CLOCK = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?`

/** Phrases that turn the clock time after them into a stop time. */
const CLOCK_LEADS = [
  // do not continue past, don't go beyond, never work after
  String.raw`(?:do\s+not|don'?t|dont|never|not)\s+(?:continue|go|work|run|keep\s+going|carry\s+on|crunch|keep\s+(?:at\s+it|working|crunching))(?:\s+on)?\s+(?:past|beyond|after|later\s+than)`,
  // stop at / by / around / before
  String.raw`(?:stop|halt|quit|pause)(?:\s+(?:everything|working|it|all))?\s+(?:at|by|around|before|no\s+later\s+than)`,
  // finish / wrap up / be done / end by
  String.raw`(?:finish|wrap\s+(?:it\s+)?up|be\s+done)(?:\s+(?:everything|it|up|work))?\s+(?:at|by|before|no\s+later\s+than)`,
  // keep crunching until / work till / go on up to
  String.raw`(?:keep|continue|carry\s+on|work|crunch|grind|go\s+on|run|loop|iterate|refin|improv|fix)\w*\b[^.?!\n]{0,60}?\b(?:until|till|til|up\s+(?:un)?til|up\s+to)`,
  // a deadline / time limit of / cut off at
  String.raw`(?:deadline|time\s+limit|cut-?\s?off)(?:\s+(?:is|of|at))?`
]

/* -------------------------------------------------------------- durations */

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90
}

const AMOUNT = String.raw`(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|fifty|sixty|ninety)`
/* "half an hour", "an hour and a half", "2 and a half hours", "1.5 hours",
   "20 minutes", "2 hrs", "45 min", "90m". */
const SPAN = String.raw`(half\s+an?\s+hour|${AMOUNT}(\s+and\s+a\s+half)?\s*(hours?|hrs?|h|minutes?|mins?|m)\b(\s+and\s+a\s+half)?)`

const SPAN_LEADS = [
  // stop after / stop in / finish within
  String.raw`(?:stop|halt|quit|finish|wrap\s+(?:it\s+)?up|be\s+done|end)(?:\s+(?:everything|working|it|up))?\s+(?:after|in|within)(?:\s+(?:about|around|roughly))?`,
  // stop after you hit / once you've worked / when you've been going
  String.raw`(?:stop|finish|wrap\s+(?:it\s+)?up)\s+(?:once|when|after)\s+(?:you(?:'ve|\s+have)?\s+)?(?:hit|reach(?:ed)?|done|worked|crunched|been\s+(?:going|working|crunching))(?:\s+(?:for|about|around))?`,
  // keep crunching for, work on it for, keep going for like
  String.raw`(?:keep|continue|carry\s+on|work|crunch|grind|go\s+on|run|loop|iterate|refin|improv|fix)\w*\b[^.?!\n]{0,60}?\bfor(?:\s+(?:about|around|roughly|like|maybe|just))*`,
  // no more than / not longer than / at most / max
  String.raw`(?:no|not)\s+(?:more|longer)\s+than|at\s+most|max(?:imum)?(?:\s+of)?`,
  // a time limit of / you have / you've got
  String.raw`(?:time\s+limit|limit)(?:\s+(?:is|of))?(?:\s+(?:about|around))?|you(?:'ve|\s+have)(?:\s+got)?`
]

/* ---------------------------------------------------------------- clearing */

const CLEAR = new RegExp(
  String.raw`\b(?:no\s+(?:time\s+limit|deadline|stop\s+time)|(?:remove|cancel|forget|ignore|drop|clear|lift)\s+(?:the|that|my)\s+(?:time\s+limit|deadline|stop\s+time|limit)|(?:keep\s+going|carry\s+on|continue|work)\s+past\s+(?:the|that)\s+(?:time|deadline|limit)|don'?t\s+stop\s+at\s+${CLOCK})`,
  'i'
)

/* ----------------------------------------------------------------- reading */

function amount(word: string): number {
  const n = Number(word)
  if (Number.isFinite(n)) return n
  return WORD_NUMBERS[word.toLowerCase()] ?? NaN
}

/** How long a SPAN match is, in ms. */
function spanMs(m: RegExpExecArray, at: number): number | null {
  const whole = m[at]
  if (/^half\s+an?\s+hour$/i.test(whole)) return 30 * MINUTE
  const n = amount(m[at + 1])
  if (!Number.isFinite(n) || n <= 0) return null
  const half = m[at + 2] || m[at + 4] ? 0.5 : 0
  const unit = m[at + 3].toLowerCase()
  const per = unit.startsWith('h') ? HOUR : MINUTE
  return (n + half) * per
}

/**
 * When `h:mm` next comes round after `now`.
 *
 * With am or pm it is that one; past 12 it is the 24-hour clock; otherwise
 * both 10:30s are candidates and the nearer one ahead wins.
 */
export function nextClock(now: number, h: number, m: number, suffix?: string): number | null {
  if (h > 23 || m > 59) return null
  const s = (suffix ?? '').toLowerCase().replace(/\./g, '')
  let hours: number[]
  if (s === 'am' || s === 'pm') {
    if (h < 1 || h > 12) return null
    hours = [(h % 12) + (s === 'pm' ? 12 : 0)]
  } else if (h === 0 || h > 12) {
    hours = [h]
  } else {
    hours = [h % 12, (h % 12) + 12]
  }
  let best: number | null = null
  for (const hour of hours) {
    for (const day of [0, 1]) {
      const d = new Date(now)
      d.setDate(d.getDate() + day)
      d.setHours(hour, m, 0, 0)
      const t = d.getTime()
      if (t > now && (best === null || t < best)) best = t
    }
  }
  return best
}

/**
 * The stop time in what the user said, if they gave one.
 *
 * The last one wins: "stop at 10, actually no, stop at 10:30" means 10:30.
 */
export function deadlineIn(text: string, now: number): DeadlineHeard | null {
  const said = text.replace(/[’‘]/g, "'")
  const clear = CLEAR.exec(said)

  let found: { at: number; said: string; index: number } | null = null
  const consider = (at: number | null, phrase: string, index: number): void => {
    if (at === null || at <= now || at - now > LONGEST) return
    if (!found || index >= found.index) found = { at, said: phrase.trim(), index }
  }

  for (const lead of CLOCK_LEADS) {
    const re = new RegExp(String.raw`\b${lead}\s+(?:about\s+|around\s+|like\s+)?${CLOCK}`, 'gi')
    for (let m = re.exec(said); m; m = re.exec(said)) {
      const [whole, h, mm, suffix] = m
      // A bare number is not a time unless it says so: "stop at 3" could be
      // the third thing. "3pm", "3:00" and "3 o'clock" are times.
      if (mm === undefined && !suffix) continue
      // "for 2 hours" read as a clock is wrong; a SPAN unit right after means a duration.
      const after = said.slice(m.index + whole.length)
      if (mm === undefined && /^\s*(?:hours?|hrs?|minutes?|mins?)\b/i.test(after)) continue
      // "Don't stop at 10:30" takes a limit back; CLEAR has it.
      if (/(?:don'?t|do\s+not|never)\s+$/i.test(said.slice(Math.max(0, m.index - 12), m.index))) continue
      const ampm = suffix && /^[ap]/i.test(suffix) ? suffix : undefined
      consider(nextClock(now, Number(h), mm === undefined ? 0 : Number(mm), ampm), whole, m.index)
    }
  }

  for (const lead of SPAN_LEADS) {
    const re = new RegExp(String.raw`\b(?:${lead})\s+(?:the\s+next\s+|another\s+)?${SPAN}`, 'gi')
    for (let m = re.exec(said); m; m = re.exec(said)) {
      const ms = spanMs(m, 1)
      if (ms !== null) consider(now + ms, m[0], m.index)
    }
  }

  const best = found as { at: number; said: string; index: number } | null
  if (clear && (!best || clear.index > best.index)) return { kind: 'clear', said: clear[0] }
  return best ? { kind: 'at', at: best.at, said: best.said } : null
}

/* --------------------------------------------------------------- speaking */

/** "10:30 pm", or "22:30", as this machine writes the time. */
export function clockText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "25 minutes", "1 hour 5 minutes", "6 hours". */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const hours = h ? `${h} hour${h === 1 ? '' : 's'}` : ''
  const mins = m ? `${m} minute${m === 1 ? '' : 's'}` : ''
  return [hours, mins].filter(Boolean).join(' ')
}

/** What Wumpy says back when it hears a stop time. The model hears it through deadlineFact. */
export function deadlineSetText(at: number, now: number): string {
  return `Stopping at ${clockText(at)}, ${spanText(at - now)} from now. Until then Wumpy keeps going; at ${clockText(at)} it stops the answer, any agents and any automatic steps.`
}

/** And when the time comes. */
export function deadlineDueText(at: number): string {
  return `It is ${clockText(at)}: stopped, as asked - the answer, any agents and the automatic steps. Say what to do next to carry on.`
}

/** The line in the model's facts while a limit is running. */
export function deadlineFact(at: number, now: number): string[] {
  if (at <= now) return []
  return [
    `- The user set a time limit: Wumpy stops everything at ${clockText(at)}, ${spanText(at - now)} from now. Until`,
    '  then keep working on what they asked - test, fix, refine - and do not stop early to ask whether to',
    '  carry on. Wumpy keeps the clock and stops you itself; you do not need to watch the time or sleep.'
  ]
}

/** And when it is taken back. */
export const DEADLINE_CLEARED_TEXT = 'Time limit removed: Wumpy will not stop at a set time.'

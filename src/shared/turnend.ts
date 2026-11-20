/**
 * Whether the line under the last answer means "finished".
 *
 * The line used to be the same grey runtime whatever was left: an answer
 * that handed Tetris to a background agent ended with "8.2s · 41 tok", the
 * same as one that had finished it. Asked for: "technically, it's not
 * finished ... add a little bubble around it ... red or yellow, mean that
 * it's not actually really finished."
 *
 *   going    yellow - something this chat started is still working: an
 *            agent, a command, or a command waiting for a click. It will
 *            come back on its own (or on the click), so the turn is not over.
 *   stopped  red - the turn ended without doing it: an error, an answer cut
 *            off part-way, or an agent that failed.
 *            Also yellow: a stop time the user set is still ahead and the
 *            answer ended before it.
 *   done     the old grey line. Nothing is left.
 *
 * Pure, so it can be checked without an app: scripts/check-turnend.mjs.
 */

import { clockText } from './deadline'

export type TurnEndTone = 'done' | 'going' | 'stopped'

export interface TurnEndFacts {
  /** This chat's agents that are queued, working or being reviewed - their titles. */
  agents: string[]
  /** This chat's agents that failed since the user last spoke - their titles. */
  failedAgents: string[]
  /** Commands running in the panel right now. */
  running: number
  /** Cards in the last answer waiting for a click: a command, a link, a search, an app. */
  waiting: number
  /** The last message is an error. */
  error: boolean
  /** The last answer stopped part-way (context full, provider filter). */
  cutOff: boolean
  /**
   * The stop time the user set, while it is still ahead. Asked to "keep
   * refining until 10:30", the model finished a snake in 84 seconds and
   * stopped: the work they asked for was not over, and the line said it was.
   */
  stopAt?: number | null
}

export interface TurnEnd {
  tone: TurnEndTone
  /** The words in the bubble; empty when done. */
  label: string
  /** The longer version, for the hover. */
  detail: string
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`
}

function named(titles: string[]): string {
  const shown = titles.slice(0, 2).map((t) => t.trim()).filter(Boolean)
  if (!shown.length) return ''
  const more = titles.length - shown.length
  return `: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

export function turnEnd(f: TurnEndFacts): TurnEnd {
  /* Red first: a failure is the thing worth seeing even while something else
     is still going, because nothing will come back to fix it. */
  if (f.error) {
    return { tone: 'stopped', label: 'not finished - it failed', detail: 'The last request failed. Say "carry on" or try again.' }
  }
  if (f.failedAgents.length) {
    const n = f.failedAgents.length
    return {
      tone: 'stopped',
      label: n === 1 ? 'not finished - an agent failed' : `not finished - ${n} agents failed`,
      detail: `${count(n, 'An agent', 'agents')} failed${named(f.failedAgents)}. Its card says why.`
    }
  }
  if (f.cutOff) {
    return {
      tone: 'stopped',
      label: 'not finished - cut off',
      detail: 'The answer stopped part-way. Say "carry on" to get the rest.'
    }
  }
  /* Yellow: it will carry on by itself, or when the card is clicked. */
  if (f.agents.length) {
    const n = f.agents.length
    return {
      tone: 'going',
      label: n === 1 ? 'not finished - an agent is still working' : `not finished - ${n} agents still working`,
      detail: `Still working in the background${named(f.agents)}. The result comes back here when it is done.`
    }
  }
  if (f.running) {
    return {
      tone: 'going',
      label: f.running === 1 ? 'not finished - a command is running' : `not finished - ${f.running} commands running`,
      detail: 'The output goes back to the model when it ends, and it carries on from there.'
    }
  }
  if (f.waiting) {
    return {
      tone: 'going',
      label: f.waiting === 1 ? 'waiting for you - the card above' : `waiting for you - ${f.waiting} cards above`,
      detail: 'Nothing happens until the card above is answered: run or skip a command, open a link, allow a search.'
    }
  }
  if (f.stopAt) {
    const at = clockText(f.stopAt)
    return {
      tone: 'going',
      label: `ended before ${at} - say carry on`,
      detail: `You asked for work until ${at}, and it stopped early. Say "carry on" to keep it going; Wumpy still stops everything at ${at}.`
    }
  }
  return { tone: 'done', label: '', detail: '' }
}

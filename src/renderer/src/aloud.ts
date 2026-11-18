/**
 * Questions on screen that a spoken turn can answer: which model, which
 * chat, delete it or keep it, and the model's own questions.
 *
 * The approvals already worked this way (see pending.ts): a card registers
 * while it waits, and a voice turn asks about it out loud. A question card
 * did not, so a spoken "/model" opened a picker nobody could see and the
 * turn ended in silence. Now every unanswered question registers here, and
 * the turn reads it out, listens, and answers it - the same as clicking.
 *
 * Each registration is numbered, so a turn only takes up the questions that
 * arrived while it was running. A question left unanswered in the chat an
 * hour ago is not what somebody pinching their earbuds is asking about.
 */
export interface AloudOption {
  /** What is handed back when this one is chosen. */
  id: string
  /** As shown and as said. */
  label: string
  /** Other things it answers to, out loud: "fastest", "the recommended one". */
  names?: string[]
  /** As read out, when not the model-name way (see LocalAsk.said). */
  said?: string
}

export interface AloudChoice {
  /** Asked after the list: "Which model?" */
  question: string
  /** Read first, and quickly: the list, in the caller's words. */
  intro?: string
  options: AloudOption[]
  /**
   * The options in the order the intro read them, for "the second one".
   * All of them, in order, when left out.
   */
  numbered?: string[]
  /** What may be asked for and cannot be picked, and why (see LocalAsk.unavailable). */
  unavailable?: Array<{ names: string[]; why: string }>
  /** Each ranking's order, by option id (see LocalAsk.ranked). */
  ranked?: Partial<Record<'balanced' | 'smarts' | 'speed', string[]>>
  /**
   * Yes or no, like an approval: nothing else answers it, and it is asked
   * again until one of them is said. The first option is yes.
   */
  confirm?: boolean
  /**
   * When it was asked. A chat opened by the turn brings its old unanswered
   * questions with it, and those are not what is being talked about now.
   */
  askedAt?: number
  choose(id: string): void
}

interface Entry {
  seq: number
  choice: AloudChoice
}

const waiting = new Map<string, Entry>()
let seq = 0
/* A card re-registers whenever it re-renders with new words; it keeps its
   number, so a turn listening for its answer does not lose track of it. */
const numbers = new Map<string, number>()

export function registerChoice(key: string, choice: AloudChoice): () => void {
  const n = numbers.get(key) ?? ++seq
  numbers.set(key, n)
  const entry = { seq: n, choice }
  waiting.set(key, entry)
  return () => {
    if (waiting.get(key) === entry) waiting.delete(key)
  }
}

/** The number the next registration will be above. */
export function choiceMark(): number {
  return seq
}

/**
 * The newest question registered after `mark` and asked no earlier than
 * `since`, if one is still waiting.
 */
export function newestChoice(mark: number, since = 0): { seq: number; choice: AloudChoice } | null {
  let found: Entry | null = null
  for (const entry of waiting.values()) {
    if (entry.seq <= mark || (entry.choice.askedAt ?? since) < since) continue
    if (!found || entry.seq > found.seq) found = entry
  }
  return found
}

/** Whether a question is still waiting - it is gone once answered. */
export function stillWaiting(n: number): boolean {
  for (const entry of waiting.values()) if (entry.seq === n) return true
  return false
}

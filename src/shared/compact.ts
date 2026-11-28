/**
 * Compacting a long conversation without making Wumpy forget how to carry on.
 *
 * "When it compacts context, the AI becomes dumber." It did, for three
 * reasons that each lost something it needed:
 *
 *   - everything before the last FOUR messages became one summary of at
 *     most 500 tokens. In a task, four messages is the last command's output
 *     and the reply to it: the request that started the task, the steps
 *     before, and the plan were all in the 500 tokens, or gone;
 *   - the summary was asked for as "a dense summary", so it kept what was
 *     talked about and lost what was being DONE - the files written, the
 *     next step, the instruction they gave twenty turns ago ("keep answers
 *     short");
 *   - a second compaction summarised the first as if it were something the
 *     assistant had said, in the same 500 tokens.
 *
 * Now: the recent turns are kept word for word up to a share of the room,
 * starting on a turn of theirs (so the task in progress is there in full);
 * the summary is a memory with set sections - their instructions quoted,
 * what is done and what is not, paths and numbers exact, where it stood -
 * with room to say it; an earlier summary is folded in as older memory; and
 * the model is told, when it reads it, that this is its own memory of turns
 * it can no longer see.
 *
 * Pure, for scripts/check-compact.mjs.
 */
import { estimateTokens } from './pressure'

/** What compaction needs of a message. */
export interface CompactMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  summary?: boolean
  /** Output handed back by the app (a command's result, a search), not typed by them. */
  automatic?: boolean
  notice?: boolean
  images?: unknown[]
}

/** The fewest messages kept word for word, whatever their size. */
export const MIN_KEEP = 4

const tokensOf = (m: CompactMessage): number => estimateTokens(m.content.length, m.images?.length ?? 0)

/** A turn they typed: where a kept stretch should start, so their request is in it. */
const theirs = (m: CompactMessage): boolean => m.role === 'user' && !m.automatic && !m.summary && !m.notice

/**
 * Where to cut: everything before `at` is summarised, from `at` on is kept as
 * it is. Kept: the newest turns up to `keepTokens`, then back to the turn of
 * theirs that began them; never fewer than MIN_KEEP. Null when there is too
 * little before the cut to be worth a summary.
 */
export function cutPoint(messages: readonly CompactMessage[], keepTokens: number): number | null {
  const n = messages.length
  if (n <= MIN_KEEP + 1) return null
  let at = n
  let used = 0
  while (at > 0) {
    const t = tokensOf(messages[at - 1])
    if (n - at >= MIN_KEEP && used + t > keepTokens) break
    used += t
    at--
  }
  /* All of it fits: the room went on pictures or the instructions. Keep the fewest. */
  if (at === 0) at = n - MIN_KEEP
  /* Back to the request that started what is kept, if it is not far: a task
     whose ask was summarised away is the task it forgets. Up to half again
     the budget, for it. */
  let start = at
  let extra = 0
  while (start > 0 && !theirs(messages[start])) {
    const t = tokensOf(messages[start - 1])
    if (extra + t > keepTokens / 2) break
    extra += t
    start--
  }
  if (start < at && theirs(messages[start])) at = start
  else {
    /* Or forward to the next turn of theirs, or failing that the next one
       handed back: so the kept part does not open on a reply to something
       it no longer has. */
    const from = at
    const find = (ok: (m: CompactMessage) => boolean): number => {
      for (let i = from; i <= n - MIN_KEEP; i++) if (ok(messages[i])) return i
      return -1
    }
    const next = [find(theirs), find((m) => m.role === 'user' && !m.summary)].find((i) => i >= 0)
    if (next !== undefined) at = next
  }
  /* Two at least to summarise, and a summary there already counts as one. */
  return at >= 2 ? at : null
}

/** How much of the room the kept turns may have: what is left of 40% once the instructions and the summary are in. */
export function keepBudget(limit: number, instructions: number, summaryTokens = SUMMARY_TOKENS): number {
  return Math.max(1500, Math.round(limit * 0.4) - Math.max(0, instructions) - summaryTokens)
}

/** The longest the summary may be. */
export const SUMMARY_TOKENS = 2000

/** One long message, for the summariser: its start and its end, which is where results and conclusions are. */
function clipped(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.round(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n[… ${text.length - max} characters left out …]\n${text.slice(-tail)}`
}

/**
 * The turns to summarise, written out for the summariser, labelled by who
 * said them - an earlier summary as what it is, output as output - and cut
 * to fit `maxChars`, the oldest cut hardest.
 */
export function transcriptFor(messages: readonly CompactMessage[], maxChars = 90_000): string {
  const label = (m: CompactMessage): string =>
    m.summary
      ? 'EARLIER SUMMARY (older memory - keep everything in it)'
      : m.notice
        ? 'App notice'
        : m.role === 'user'
          ? m.automatic
            ? 'Output handed back to the assistant'
            : 'User'
          : m.role === 'system'
            ? 'App notice'
            : 'Assistant'
  let per = 8000
  for (;;) {
    const parts = messages.map((m, i) => {
      /* An earlier summary is never cut: it is all that is left of what it covers. */
      const cap = m.summary ? Infinity : i >= messages.length - 6 ? per * 2 : per
      const pics = m.images?.length ? ` [${m.images.length} picture${m.images.length === 1 ? '' : 's'} not shown]` : ''
      return `### ${label(m)}${pics}\n${clipped(m.content.trim(), cap)}`
    })
    const text = parts.join('\n\n')
    if (text.length <= maxChars || per <= 600) return text
    per = Math.round(per * 0.6)
  }
}

/** The instructions for writing the summary. */
export const COMPACT_PROMPT = [
  'You write the memory that lets an assistant called Wumpy carry on a conversation after its earlier turns are removed to make room.',
  'Wumpy will see only what you write plus the most recent turns. Anything you leave out, it has forgotten - so leave out only small talk and repetition.',
  '',
  'Write these sections, with these headings, in this order. Skip a section only when there is truly nothing for it.',
  '',
  "## The user's instructions",
  'Every standing instruction or preference the user gave - how to answer, what to call things, what never to do - quoted word for word.',
  '## What the user asked for',
  'Each request, in order, marked (done), (in progress) or (not started). Quote the latest one word for word.',
  '## What was done',
  'Commands run, files written or changed (full paths), pages opened, searches made - and what each one produced or showed.',
  '## Facts learned',
  'About the user, their computer, their project: exact names, versions, numbers, paths, IDs, URLs, errors.',
  '## Decisions',
  'What was chosen and why, and what the user turned down.',
  '## Problems',
  'Each error or failure, and how it was fixed - or that it is still open.',
  '## Where it stands',
  'What was in progress when this memory was written, what the assistant last said it would do, and the next step.',
  '',
  'If an EARLIER SUMMARY is included, everything in it goes into yours: it is older memory, and it is the only copy.',
  'Be exact: the real path, number, name or command, never "a file", "some settings" or "an error". Code and commands in backticks.',
  'Third person ("the user", "Wumpy"). No preamble, nothing after the last section.'
].join('\n')

/** The request to the summariser for these turns. */
export function compactRequest(messages: readonly CompactMessage[]): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: COMPACT_PROMPT },
    { role: 'user', content: `The conversation so far:\n\n${transcriptFor(messages)}\n\nWrite the memory now.` }
  ]
}

/** How the summary reads to the model on every turn after: its own memory, not something said to it. */
export function asMemory(summary: string): string {
  return [
    'YOUR MEMORY OF THE EARLIER PART OF THIS CONVERSATION. Those turns were removed to make room; this is what',
    'happened in them. Rely on it as you would on the turns themselves: carry on any task in it, follow every',
    "instruction of the user's quoted in it, and do not say you cannot remember them.",
    '',
    summary.trim()
  ].join('\n')
}

/**
 * Self-reflection: one model works, a second one reviews, until the review
 * passes.
 *
 * The worker is the ordinary chat - it answers, proposes commands, reads
 * their output, keeps going. When it has finished (nothing streaming, nothing
 * waiting for approval, nothing still running) the whole task so far goes to
 * a mentor: the same model or another, on the OTHER key where there are two,
 * so the review costs the allowance the work did not. The mentor answers
 * ACCEPT or REVISE with notes. REVISE goes back to the worker as an automatic
 * message and the loop runs again; ACCEPT, or the round limit, ends it.
 *
 * Kept pure so the parts that decide things - what the mentor is shown, how
 * its verdict is read, what the worker is told - can be checked without a
 * key or a network.
 */

/** Messages as the renderer has them; only what the mentor needs. */
export interface ReflectMessage {
  role: string
  content: string
  automatic?: boolean
  local?: boolean
  error?: string
  notice?: boolean
  summary?: boolean
}

export interface ReflectReview {
  verdict: 'accept' | 'revise'
  notes: string
  model: string
}

export const MENTOR_PROMPT = [
  'You are the MENTOR. Another assistant, the WORKER, was given a task by the user and has',
  'just finished it, possibly after running commands on the user’s computer whose output',
  'it was shown. You review that work the way a senior engineer reviews a junior’s:',
  '',
  '- Does it do what the user actually asked - all of it, not a nearby easier thing?',
  '- Is it correct? Bugs, wrong commands, wrong facts, off-by-ones, missing edge cases.',
  '- Is every claim backed by something in the transcript? "Installed", "fixed", "works"',
  '  need output that shows it. A claim with nothing behind it is a REVISE.',
  '- For code: would it compile and run, is anything left as a placeholder or TODO? For code',
  '  that RUNS - a page, a game, a script - run it in your head once: every name defined where',
  '  it is used; speeds and timers per second, scaled by the frame time, never per frame; every',
  '  part asked for really there (controls, score, losing, "keeps going"). A game whose cars',
  '  cross the screen in a twentieth of a second is not done, whatever it claims.',
  '- If the user said it does not work: did the worker read the file and find the cause, or',
  '  guess one? A guess is a REVISE. So is fixing only what they named when more is broken.',
  '- If Wumpy loaded a page and reported console errors, the work is not done until they are gone.',
  '',
  'You do not redo the work and you do not write the answer yourself. You say what must',
  'change, concretely enough that the worker can act on it without guessing. Small style',
  'preferences are not a reason to REVISE. If the work is right, ACCEPT it - an extra round',
  'that changes nothing costs the user time and quota.',
  '',
  'Reply in exactly this form and nothing else:',
  'VERDICT: ACCEPT',
  'NOTES: <one sentence saying why it is right>',
  'or',
  'VERDICT: REVISE',
  'NOTES:',
  '1. <what must change, and why>',
  '2. <...>'
].join('\n')

/**
 * Where the task began: the newest message the user wrote themselves.
 * Automatic hand-backs (command output, earlier reviews) belong to it.
 */
export function taskStart(messages: ReflectMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.automatic && !m.local) return i
  }
  return -1
}

/**
 * Whether there is finished work to review: a task, and after it a final
 * answer that is not an error. An empty answer or a failed turn is not
 * something a mentor can judge, and reviewing it would only add noise.
 */
export function reviewable(messages: ReflectMessage[]): boolean {
  const start = taskStart(messages)
  if (start < 0) return false
  const last = [...messages.slice(start + 1)]
    .reverse()
    .find((m) => !m.local && !m.notice && !m.summary)
  return Boolean(last && last.role === 'assistant' && !last.error && last.content.trim())
}

/**
 * What the mentor reads: the task and everything the worker did for it, as
 * one labelled document. Long command output is cut in the middle - the start
 * and the end of a log are where its meaning is - so one huge listing cannot
 * crowd out the work itself.
 */
export function mentorTranscript(messages: ReflectMessage[], limit = 24_000): string {
  const start = taskStart(messages)
  if (start < 0) return ''
  const parts: string[] = []
  for (const m of messages.slice(start)) {
    if (m.local || m.notice || m.summary || m.error) continue
    if (!m.content.trim()) continue
    const who =
      m.role === 'assistant'
        ? 'WORKER'
        : m.automatic
          ? 'APP (automatic - command output or an earlier review)'
          : 'USER'
    parts.push(`### ${who}\n${clip(m.content.trim(), 6000)}`)
  }
  let text = parts.join('\n\n')
  if (text.length > limit) {
    // Keep the task and the newest work; the middle is what goes.
    const head = text.slice(0, Math.floor(limit * 0.3))
    const tail = text.slice(text.length - Math.floor(limit * 0.65))
    text = `${head}\n\n[... earlier steps cut for length ...]\n\n${tail}`
  }
  return text
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n[... ${text.length - max} characters cut ...]\n${text.slice(-half)}`
}

/**
 * The mentor's verdict, read leniently: models add bold, change case, or put
 * the verdict on the line after the label. Anything that does not clearly say
 * ACCEPT is a REVISE - an unreadable review is not a pass.
 */
export function parseReview(raw: string): { verdict: 'accept' | 'revise'; notes: string } | null {
  const text = raw.replace(/\*\*/g, '').trim()
  if (!text) return null
  const verdict = /VERDICT\s*:?\s*\n?\s*(ACCEPT|REVISE)/i.exec(text)
  const notesAt = /NOTES\s*:?/i.exec(text)
  const notes = notesAt ? text.slice(notesAt.index + notesAt[0].length).trim() : text
  if (!verdict) {
    // No label at all: only a bare leading ACCEPT counts.
    if (/^ACCEPT\b/i.test(text)) return { verdict: 'accept', notes: text.replace(/^ACCEPT\W*/i, '') }
    return { verdict: 'revise', notes }
  }
  return { verdict: verdict[1].toUpperCase() === 'ACCEPT' ? 'accept' : 'revise', notes }
}

/** What the worker is told when the mentor asks for changes. */
export function handBack(notes: string, round: number, rounds: number): string {
  return [
    `[Automatic: self-reflection, review ${round} of ${rounds}. Not from the user.]`,
    'A mentor reviewed your work on this task and asked for changes before it is accepted:',
    '',
    notes.trim(),
    '',
    'Address every point. Where a point is wrong, say why in one sentence instead of',
    'changing it. Use commands where checking needs them. Then give the complete, final',
    'answer again - not just the parts that changed.'
  ].join('\n')
}

/** The rounds setting, kept to something sensible whatever was typed. */
export function clampRounds(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(8, Math.max(1, Math.round(n)))
}

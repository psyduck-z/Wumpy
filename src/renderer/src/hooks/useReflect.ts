import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { clampRounds, handBack, mentorTranscript, reviewable, taskStart } from '@shared/reflect'
import { onPendingChange, pendingCount, runningCount, startedRunning } from '../pending'

/**
 * Self-reflection, in the panel: the loop between the worker and the mentor.
 *
 * Waits for a task to be really finished - nothing streaming, nothing waiting
 * for approval, no approved command still running, and staying that way for a
 * moment, since a finished command hands its output back a beat after it
 * ends. Then the task and everything done for it goes to the mentor (main
 * process, on the other key). ACCEPT ends it; REVISE goes back to the worker
 * as an automatic message, which starts the next pass, and the next finish
 * comes round here again.
 *
 * Each review is a note in the transcript, rewritten from "reviewing" to its
 * verdict, so the back-and-forth is visible; the hand-back itself is
 * automatic and hidden like any other. A new message from the user is a new
 * task and starts the count again. While a review is out it counts as
 * running work (startedRunning), so a voice turn waits for it.
 */
interface Deps {
  enabled: boolean
  rounds: number
  streaming: boolean
  messages: ChatMessage[]
  /**
   * The chat's send, as an automatic message: hidden from the transcript but
   * kept whole in the history, so the next review can see what was asked for.
   */
  send(text: string): boolean
  liveNote(content: string): string
  update(id: string, content: string): void
}

/** How long the task has to stay finished before it counts as finished. */
const SETTLE_MS = 1500

export function useReflect(deps: Deps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  /**
   * The task in hand: its first message, reviews so far, the answer last
   * reviewed, and a hand-back that could not be sent yet.
   */
  const task = useRef<{
    id: string
    reviews: number
    reviewed: string | null
    unsent: string | null
    done: boolean
  } | null>(null)
  const busy = useRef(false)

  // Approving or skipping a card changes nothing in the transcript by itself,
  // and a skipped last command is a finished task: re-check when either happens.
  const [pendingTick, setPendingTick] = useState(0)
  useEffect(() => onPendingChange(() => setPendingTick((t) => t + 1)), [])

  useEffect(() => {
    if (!deps.enabled || deps.streaming || busy.current) return
    const timer = setTimeout(() => void consider(), SETTLE_MS)
    return () => clearTimeout(timer)

    async function consider(): Promise<void> {
      const d = depsRef.current
      if (!d.enabled || d.streaming || busy.current) return
      if (pendingCount() > 0 || runningCount() > 0) return

      const messages = d.messages
      const start = taskStart(messages)
      if (start < 0) return
      const id = messages[start].id
      if (task.current?.id !== id)
        task.current = { id, reviews: 0, reviewed: null, unsent: null, done: false }
      const t = task.current
      if (t.done) return
      // A verdict that arrived while a send was refused goes now, unreviewed again.
      if (t.unsent) {
        if (d.send(t.unsent)) t.unsent = null
        return
      }
      if (!reviewable(messages)) return

      const answer = messages.findLast((m) => m.role === 'assistant')
      if (!answer || t.reviewed === answer.id) return

      const rounds = clampRounds(d.rounds)
      if (t.reviews >= rounds) {
        t.done = true
        d.liveNote(
          `Self-reflection stopped after ${rounds} review${rounds === 1 ? '' : 's'} without a pass — ` +
            'the last notes are above. `/reflect 5` allows more.'
        )
        return
      }

      busy.current = true
      t.reviewed = answer.id
      t.reviews++
      const round = t.reviews
      const ended = startedRunning()
      const noteId = d.liveNote(`Mentor reviewing… (${round} of ${rounds})`)
      try {
        const review = await window.wumpy.reflect.review(mentorTranscript(messages))
        const now = depsRef.current
        // The user moved on while the mentor was reading: this review is moot.
        const still = taskStart(now.messages)
        if (still < 0 || now.messages[still].id !== id) {
          now.update(noteId, `Mentor review ${round} dropped — a new task started.`)
          return
        }
        if (!review) {
          t.done = true
          now.update(
            noteId,
            'Mentor could not review this (no model answered). The work above is unreviewed.'
          )
          return
        }
        if (review.verdict === 'accept') {
          t.done = true
          now.update(
            noteId,
            `**Mentor accepted** (review ${round} of ${rounds}, ${review.model})` +
              (review.notes ? ` — ${review.notes}` : '')
          )
          return
        }
        now.update(
          noteId,
          `**Mentor asked for changes** (review ${round} of ${rounds}, ${review.model}):\n\n${review.notes}`
        )
        // Back to the worker. If it cannot be sent this instant, the next
        // settle sends the same verdict rather than paying for a new one.
        const back = handBack(review.notes, round, rounds)
        if (!now.send(back)) t.unsent = back
      } finally {
        busy.current = false
        ended()
      }
    }
  }, [deps.enabled, deps.streaming, deps.messages, pendingTick])
}

import { useEffect, useRef } from 'react'
import type { AgentDelivery, ChatMessage } from '@shared/types'
import { onPendingChange, pendingCount, runningCount } from '../pending'

/**
 * Background agents, from the panel's side: starting the ones an answer
 * asks for, and handing their reports back to the chat.
 *
 * Started when an answer FINISHES, from that answer's text - never from a
 * card rendering, which would start them again for a chat reopened from
 * disk. Main starts each block once whatever asks.
 *
 * A report goes back as an automatic message - hidden, like a command's
 * output, with a chip saying what came back - once the chat it belongs to
 * is open and nothing is going on in it: no answer being written, no card
 * waiting for a click, no command running. Otherwise it waits in main, and
 * comes when that chat is opened again.
 */
interface Deps {
  chatId: string
  streaming: boolean
  streamingId: string | null
  messages: ChatMessage[]
  /** The chat's send, as an automatic message. False when a turn is in flight. */
  send(text: string, shown: string): boolean
  note(content: string): void
  notify(content: string): void
}

/** How long the chat must stay idle before a report is handed in. */
const SETTLE_MS = 1500

export function useAgents(deps: Deps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  /* ----------------------------------------------------------- starting */

  const writing = useRef<string | null>(null)
  useEffect(() => {
    if (deps.streaming) {
      writing.current = deps.streamingId
      return
    }
    const id = writing.current
    writing.current = null
    if (!id) return
    const d = depsRef.current
    const message = d.messages.find((m) => m.id === id)
    if (!message || message.role !== 'assistant' || message.error) return
    if (!/```[ \t]*wumpy-(agent|monitor)\b/.test(message.content)) return
    void window.wumpy.agents
      .start(d.chatId, message.id, message.content)
      .then((r) => {
        if (r?.refused) depsRef.current.note(r.refused)
        else if (r?.started?.length) {
          const n = r.started.length
          depsRef.current.notify(`${n === 1 ? 'A background agent is' : `${n} background agents are`} working on it`)
        }
      })
      .catch(() => {})
  }, [deps.streaming, deps.streamingId])

  /* --------------------------------------------------------- reporting */

  const queue = useRef<AgentDelivery[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const consider = useRef<() => void>(() => {})
  consider.current = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const d = depsRef.current
    const next = queue.current.find((q) => q.chatId === d.chatId)
    if (!next) return
    timer.current = setTimeout(() => {
      timer.current = null
      const now = depsRef.current
      if (now.chatId !== next.chatId) return
      if (now.streaming || pendingCount() > 0 || runningCount() > 0) {
        /* Busy: look again shortly rather than wait for a change that
           may already have happened. */
        timer.current = setTimeout(() => consider.current(), 2000)
        return
      }
      const count = (next.text.match(/^AGENT \d+:/gm) ?? []).length
      const shown = count > 1 ? `${count} background agents reported` : 'A background agent reported'
      if (!now.send(next.text, shown)) {
        timer.current = setTimeout(() => consider.current(), 2000)
        return
      }
      now.notify(shown)
      queue.current = queue.current.filter((q) => q.id !== next.id)
      void window.wumpy.agents.delivered(next.id)
      consider.current()
    }, SETTLE_MS)
  }

  const add = (list: readonly AgentDelivery[]): void => {
    for (const d of list) if (!queue.current.some((q) => q.id === d.id)) queue.current.push(d)
    consider.current()
  }

  useEffect(() => window.wumpy.agents.onReady((d) => add([d])), [])
  useEffect(() => {
    void window.wumpy.agents
      .pending(deps.chatId)
      .then(add)
      .catch(() => {})
  }, [deps.chatId])
  /* A turn ending, a card answered: the moment a waiting report can go. */
  useEffect(() => {
    if (!deps.streaming) consider.current()
  }, [deps.streaming])
  useEffect(() => onPendingChange(() => consider.current()), [])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
}

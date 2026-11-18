import { useSyncExternalStore } from 'react'
import type { AgentView, MonitorView } from '@shared/types'

/**
 * Every background agent and monitor main knows about, for the cards.
 *
 * One copy for the whole panel, kept current by main's agentsChanged, so a
 * card in an old message and the one being written read the same list.
 */
type State = { agents: AgentView[]; monitors: MonitorView[] }

let state: State = { agents: [], monitors: [] }
const listeners = new Set<() => void>()
let started = false

function begin(): void {
  if (started || typeof window === 'undefined' || !window.wumpy?.agents) return
  started = true
  window.wumpy.agents.onChanged((next) => {
    if (!next) return
    state = next
    for (const l of listeners) l()
  })
  void window.wumpy.agents
    .list()
    .then((next) => {
      state = next
      for (const l of listeners) l()
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  begin()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAgentState(): State {
  return useSyncExternalStore(subscribe, () => state)
}

/** The agent a block in a message started, by the message and the block's title. */
export function agentFor(list: readonly AgentView[], messageId: string, title: string): AgentView | undefined {
  return list.find((a) => a.key.startsWith(`${messageId}:`) && a.title === title)
}

export function monitorFor(list: readonly MonitorView[], messageId: string, note: string): MonitorView | undefined {
  return list.find((m) => m.key.startsWith(`${messageId}:monitor:`) && m.note === note)
}

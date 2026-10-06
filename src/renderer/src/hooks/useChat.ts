import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, TierId } from '@shared/types'

let counter = 0
export const nextId = (): string => `m${Date.now().toString(36)}${(counter++).toString(36)}`

/** Live and last-turn numbers for the status bar. */
export interface ChatStats {
  /** Tokens/sec for the most recent completed answer. */
  speed: number | null
  /** Model load time for the last answer; near zero means it was warm. */
  loadMs: number | null
  /** Counted by Ollama: what the next request will start from. */
  contextTokens: number | null
  lastCompletionTokens: number | null
  /** Tokens seen so far in the turn currently streaming. */
  liveTokens: number
  /** Milliseconds since the current turn started, or null when idle. */
  elapsedMs: number | null
}

export interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  stats: ChatStats
  send(text: string, tier: TierId, displayText?: string): void
  /** Messages as the model would see them, for size estimates and compaction. */
  history(): Array<{ role: string; content: string }>
  /** Adds a local-only note (command output, errors) without calling the model. */
  note(content: string, error?: boolean): void
  /** Adds a line the model will see as context, shown as a chip. */
  notice(content: string): void
  stop(): void
  clear(): void
  replace(messages: ChatMessage[]): void
}

export function useChat(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [stats, setStats] = useState<ChatStats>({
    speed: null,
    loadMs: null,
    contextTokens: null,
    lastCompletionTokens: null,
    liveTokens: 0,
    elapsedMs: null
  })
  /** Wall clock for the turn in flight, so elapsed survives re-renders. */
  const startedAt = useRef<number | null>(null)

  /** Request currently streaming; also the key we match incoming deltas against. */
  const activeRequest = useRef<string | null>(null)
  /** Assistant message being filled by that request. */
  const activeMessage = useRef<string | null>(null)
  /** Mirrors `messages` so `send` can read history without a stale closure. */
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  const patchActive = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const target = activeMessage.current
    if (!target) return
    setMessages((prev) => prev.map((m) => (m.id === target ? patch(m) : m)))
  }, [])

  useEffect(() => {
    const offDelta = window.wumpy.chat.onDelta((d) => {
      if (d.requestId !== activeRequest.current) return
      patchActive((m) => ({
        ...m,
        content: d.content ? m.content + d.content : m.content,
        thinking: d.thinking ? (m.thinking ?? '') + d.thinking : m.thinking
      }))
      // Ollama streams one message per token, so counting them is exact.
      setStats((s) => ({ ...s, liveTokens: s.liveTokens + 1 }))
    })

    const offDone = window.wumpy.chat.onDone((d) => {
      if (d.requestId !== activeRequest.current) return
      setStats((s) => ({
        speed: d.tokensPerSecond ?? s.speed,
        loadMs: d.loadMs ?? null,
        // What the model read plus what it wrote is where the next turn starts.
        contextTokens:
          d.promptTokens !== undefined
            ? d.promptTokens + (d.completionTokens ?? 0)
            : s.contextTokens,
        lastCompletionTokens: d.completionTokens ?? null,
        liveTokens: 0,
        elapsedMs: null
      }))
      startedAt.current = null
      activeRequest.current = null
      activeMessage.current = null
      setStreaming(false)
    })

    const offError = window.wumpy.chat.onError((d) => {
      if (d.requestId !== activeRequest.current) return
      patchActive((m) => ({ ...m, error: d.message }))
      startedAt.current = null
      activeRequest.current = null
      activeMessage.current = null
      setStats((s) => ({ ...s, liveTokens: 0, elapsedMs: null }))
      setStreaming(false)
    })

    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [patchActive])

  const send = useCallback((text: string, tier: TierId, displayText?: string) => {
    const trimmed = text.trim()
    if (!trimmed || activeRequest.current) return

    const userMessage: ChatMessage = {
      id: nextId(),
      role: 'user',
      // A command such as /plan sends a wrapped prompt but shows what was typed.
      content: displayText ?? trimmed,
      createdAt: Date.now()
    }
    const assistantMessage: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      tier
    }

    // History comes from the ref, never from inside a state updater: React
    // replays updaters under StrictMode, which would fire the request twice.
    // The wrapped text is what the model sees.
    // Command output and failed turns are not conversation: feeding /help back
    // to the model would waste context and confuse the next answer. Compaction
    // summaries go in as system messages so they read as context rather than as
    // something the assistant said.
    const history = [
      ...messagesRef.current.filter((m) => !m.error && !m.local),
      { ...userMessage, content: trimmed }
    ].map((m) => {
      if (m.summary) {
        return { role: 'system' as const, content: `Earlier in this conversation: ${m.content}` }
      }
      // Notices are app facts the model must act on, not chat turns.
      if (m.notice) return { role: 'system' as const, content: m.content }
      return { role: m.role, content: m.content }
    })

    const requestId = nextId()
    activeRequest.current = requestId
    activeMessage.current = assistantMessage.id

    startedAt.current = Date.now()
    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setStreaming(true)
    setStats((s) => ({ ...s, speed: null, liveTokens: 0, elapsedMs: 0 }))

    void window.wumpy.chat.send({ requestId, messages: history, tier })
  }, [])

  useEffect(() => {
    if (!streaming) return
    // 100ms is enough for a tenths-of-a-second readout and costs nothing.
    const timer = setInterval(() => {
      if (startedAt.current === null) return
      setStats((s) => ({ ...s, elapsedMs: Date.now() - (startedAt.current ?? Date.now()) }))
    }, 100)
    return () => clearInterval(timer)
  }, [streaming])

  const history = useCallback(
    () =>
      messagesRef.current
        .filter((m) => !m.error && !m.local)
        .map((m) => ({ role: m.notice ? 'system' : (m.role as string), content: m.content })),
    []
  )

  const note = useCallback((content: string, error = false) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'assistant',
        content: error ? '' : content,
        error: error ? content : undefined,
        createdAt: Date.now(),
        local: true
      }
    ])
  }, [])

  const notice = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'system', content, createdAt: Date.now(), notice: true }
    ])
  }, [])

  const stop = useCallback(() => {
    if (!activeRequest.current) return
    window.wumpy.chat.abort(activeRequest.current)
    activeRequest.current = null
    activeMessage.current = null
    startedAt.current = null
    setStats((s) => ({ ...s, liveTokens: 0, elapsedMs: null }))
    setStreaming(false)
  }, [])

  const clear = useCallback(() => {
    stop()
    setMessages([])
    setStats({
      speed: null,
      loadMs: null,
      contextTokens: null,
      lastCompletionTokens: null,
      liveTokens: 0,
      elapsedMs: null
    })
  }, [stop])

  const replace = useCallback(
    (next: ChatMessage[]) => {
      stop()
      setMessages(next)
      // The counted context belonged to the old conversation; fall back to the
      // estimate until the next turn reports real numbers.
      setStats((s) => ({ ...s, contextTokens: null }))
    },
    [stop]
  )

  return { messages, streaming, stats, send, history, note, notice, stop, clear, replace }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, TierId } from '@shared/types'

let counter = 0
export const nextId = (): string => `m${Date.now().toString(36)}${(counter++).toString(36)}`

export interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  /** Tokens/sec for the most recent completed answer. */
  lastSpeed: number | null
  /** Model load time for the last answer; near zero means it was warm. */
  lastLoadMs: number | null
  send(text: string, tier: TierId, displayText?: string): void
  /** Adds a local-only note (command output, errors) without calling the model. */
  note(content: string, error?: boolean): void
  stop(): void
  clear(): void
  replace(messages: ChatMessage[]): void
}

export function useChat(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [lastSpeed, setLastSpeed] = useState<number | null>(null)
  const [lastLoadMs, setLastLoadMs] = useState<number | null>(null)

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
    })

    const offDone = window.wumpy.chat.onDone((d) => {
      if (d.requestId !== activeRequest.current) return
      setLastSpeed(d.tokensPerSecond ?? null)
      setLastLoadMs(d.loadMs ?? null)
      activeRequest.current = null
      activeMessage.current = null
      setStreaming(false)
    })

    const offError = window.wumpy.chat.onError((d) => {
      if (d.requestId !== activeRequest.current) return
      patchActive((m) => ({ ...m, error: d.message }))
      activeRequest.current = null
      activeMessage.current = null
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
    // to the model would waste context and confuse the next answer.
    const history = [
      ...messagesRef.current.filter((m) => !m.error && !m.local),
      { ...userMessage, content: trimmed }
    ].map(({ role, content }) => ({ role, content }))

    const requestId = nextId()
    activeRequest.current = requestId
    activeMessage.current = assistantMessage.id

    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setStreaming(true)
    setLastSpeed(null)

    void window.wumpy.chat.send({ requestId, messages: history, tier })
  }, [])

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

  const stop = useCallback(() => {
    if (!activeRequest.current) return
    window.wumpy.chat.abort(activeRequest.current)
    activeRequest.current = null
    activeMessage.current = null
    setStreaming(false)
  }, [])

  const clear = useCallback(() => {
    stop()
    setMessages([])
    setLastSpeed(null)
    setLastLoadMs(null)
  }, [stop])

  const replace = useCallback(
    (next: ChatMessage[]) => {
      stop()
      setMessages(next)
    },
    [stop]
  )

  return { messages, streaming, lastSpeed, lastLoadMs, send, note, stop, clear, replace }
}

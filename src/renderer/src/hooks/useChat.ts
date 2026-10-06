import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'

let counter = 0
const nextId = (): string => `m${Date.now().toString(36)}${(counter++).toString(36)}`

export interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  /** Tokens/sec reported for the most recent completed answer. */
  lastSpeed: number | null
  send(text: string, model?: string): void
  stop(): void
  clear(): void
}

export function useChat(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [lastSpeed, setLastSpeed] = useState<number | null>(null)

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

  const send = useCallback(
    (text: string, model?: string) => {
      const trimmed = text.trim()
      if (!trimmed || activeRequest.current) return

      const userMessage: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now()
      }
      const assistantMessage: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        model
      }

      // History comes from the ref, never from inside a state updater: React
      // replays updaters under StrictMode, which would fire the request twice.
      const history = [...messagesRef.current, userMessage].map(({ role, content }) => ({
        role,
        content
      }))
      const requestId = nextId()
      activeRequest.current = requestId
      activeMessage.current = assistantMessage.id

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setStreaming(true)
      setLastSpeed(null)

      void window.wumpy.chat.send({ requestId, messages: history, model })
    },
    []
  )

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
  }, [stop])

  return { messages, streaming, lastSpeed, send, stop, clear }
}

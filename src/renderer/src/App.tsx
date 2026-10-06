import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HotkeyState, OllamaModel, OllamaStatus, WumpySettings } from '@shared/types'
import { useChat } from './hooks/useChat'
import { Header } from './components/Header'
import { Message } from './components/Message'
import { Composer } from './components/Composer'

/** Mirrors the main process's accelerator formatting for display. */
function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}

export default function App(): React.JSX.Element {
  const { messages, streaming, lastSpeed, send, stop, clear } = useChat()
  const [settings, setSettings] = useState<WumpySettings | null>(null)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [hotkey, setHotkey] = useState<HotkeyState>({ active: null, failed: [], intercepted: null })
  const [pinned, setPinned] = useState(false)
  const [visible, setVisible] = useState(false)
  const [focusToken, setFocusToken] = useState(0)

  const scroller = useRef<HTMLDivElement>(null)
  /** False once the user scrolls up, so streaming does not yank them back down. */
  const stickToBottom = useRef(true)

  useEffect(() => {
    void window.wumpy.settings.get().then(setSettings)
    void window.wumpy.hotkey.get().then(setHotkey)
    return window.wumpy.hotkey.onChange(setHotkey)
  }, [])

  // Poll Ollama so the status dot reflects the server coming up or going away.
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const next = await window.wumpy.ollama.status()
      if (cancelled) return
      setStatus(next)
      if (next.reachable) setModels(await window.wumpy.ollama.models())
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Trigger the slide-in on mount and on every hotkey press.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    const off = window.wumpy.panel.onShown(() => {
      setVisible(true)
      setFocusToken((n) => n + 1)
    })
    return () => {
      cancelAnimationFrame(raf)
      off()
    }
  }, [])

  const close = useCallback(() => {
    setVisible(false)
    // Let the slide-out play before the window actually disappears.
    setTimeout(() => window.wumpy.panel.hide(), 140)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (streaming) stop()
        else close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, stop, streaming])

  useLayoutEffect(() => {
    if (stickToBottom.current) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
    }
  }, [messages])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    window.wumpy.panel.setPinned(next)
  }

  const changeModel = (name: string): void => {
    setSettings((prev) => (prev ? { ...prev, chatModel: name } : prev))
    void window.wumpy.settings.set({ chatModel: name })
  }

  const model = settings?.chatModel ?? ''
  // The intercepted key (Win+C) wins: it is the one the user actually asked for.
  const liveKey = hotkey.intercepted ?? hotkey.active
  const hotkeyLabel = liveKey ? prettify(liveKey) : 'no hotkey — use the tray'

  return (
    <div className={`panel ${visible ? 'panel-in' : ''}`}>
      <Header
        models={models}
        model={model}
        onModelChange={changeModel}
        status={status}
        pinned={pinned}
        onTogglePin={togglePin}
        onClear={clear}
        onClose={close}
        hotkeyLabel={hotkeyLabel}
      />

      <div className="scroll" ref={scroller} onScroll={onScroll}>
        {messages.length === 0 ? (
          <Empty hotkeyLabel={hotkeyLabel} online={status?.reachable ?? false} model={model} />
        ) : (
          messages.map((m, i) => (
            <Message key={m.id} message={m} streaming={streaming && i === messages.length - 1} />
          ))
        )}
      </div>

      <footer className="status">
        {streaming ? (
          <span>generating…</span>
        ) : lastSpeed ? (
          <span>{lastSpeed.toFixed(1)} tok/s</span>
        ) : (
          <span>{model}</span>
        )}
        <span className="spacer" />
        <span>Enter to send &middot; Shift+Enter newline &middot; Esc to close</span>
      </footer>

      <Composer onSend={(t) => send(t, model)} onStop={stop} streaming={streaming} focusToken={focusToken} />
    </div>
  )
}

function Empty({
  hotkeyLabel,
  online,
  model
}: {
  hotkeyLabel: string
  online: boolean
  model: string
}): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark">W</div>
      <h1>Wumpy</h1>
      {online ? (
        <p>
          Running <code>{model}</code> locally. Press <kbd>{hotkeyLabel}</kbd> anywhere to summon
          this panel.
        </p>
      ) : (
        <p>
          Can&rsquo;t reach Ollama. Start it with <code>ollama serve</code>, then this panel will
          connect on its own.
        </p>
      )}
    </div>
  )
}

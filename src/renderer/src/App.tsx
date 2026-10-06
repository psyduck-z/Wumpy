import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ChatSummary,
  Dock,
  HotkeyState,
  Mode,
  OllamaStatus,
  TierId,
  TierStatus,
  WumpySettings
} from '@shared/types'
import { isTall } from '@shared/types'
import { TIERS, defaultTierFor } from '@shared/tiers'
import { useChat, nextId } from './hooks/useChat'
import { parseCommand, helpText, type CommandAction } from './commands'
import { Header } from './components/Header'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { TierBar } from './components/TierBar'
import { ChatList } from './components/ChatList'

/** Mirrors the main process's accelerator formatting for display. */
function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}

export default function App(): React.JSX.Element {
  const chat = useChat()
  const { messages, streaming, lastSpeed, lastLoadMs } = chat

  const [settings, setSettings] = useState<WumpySettings | null>(null)
  const [tierStatuses, setTierStatuses] = useState<TierStatus[]>([])
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [hotkey, setHotkey] = useState<HotkeyState>({
    active: null,
    failed: [],
    intercepted: null
  })
  const [pinned, setPinned] = useState(false)
  const [visible, setVisible] = useState(false)
  const [focusToken, setFocusToken] = useState(0)

  // Saved chats
  const [showChats, setShowChats] = useState(false)
  const [savedChats, setSavedChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string>(() => nextId())
  const [chatTitle, setChatTitle] = useState<string | null>(null)

  const scroller = useRef<HTMLDivElement>(null)
  /** False once the user scrolls up, so streaming does not yank them back down. */
  const stickToBottom = useRef(true)

  const mode: Mode = settings?.mode ?? 'quick'
  const tier: TierId = settings?.tier ?? 'fast'
  const dock: Dock = settings?.dock ?? 'right'

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    void window.wumpy.settings.get().then(setSettings)
    void window.wumpy.hotkey.get().then(setHotkey)
    void window.wumpy.tiers.status().then(setTierStatuses)
    void window.wumpy.chats.list().then(setSavedChats)
    return window.wumpy.hotkey.onChange(setHotkey)
  }, [])

  useEffect(() => window.wumpy.tiers.onStatus(setTierStatuses), [])
  useEffect(
    () =>
      window.wumpy.panel.onDock((d) => setSettings((prev) => (prev ? { ...prev, dock: d } : prev))),
    []
  )

  // Poll Ollama so the status dot reflects the server coming up or going away.
  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const next = await window.wumpy.ollama.status()
      if (!cancelled) setStatus(next)
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

  /* ---------------------------------------------------------------- actions */

  const patch = useCallback(async (p: Partial<WumpySettings>) => {
    const next = await window.wumpy.settings.set(p)
    setSettings(next)
    return next
  }, [])

  const close = useCallback(() => {
    setVisible(false)
    // Let the slide-out play before the window actually disappears.
    setTimeout(() => window.wumpy.panel.hide(), 140)
  }, [])

  const refreshChats = useCallback(async () => {
    setSavedChats(await window.wumpy.chats.list())
  }, [])

  const newChat = useCallback(() => {
    chat.clear()
    setChatId(nextId())
    setChatTitle(null)
    setShowChats(false)
  }, [chat])

  const saveChat = useCallback(
    async (title?: string) => {
      if (chat.messages.length === 0) {
        chat.note('Nothing to save yet.', true)
        return
      }
      const summary = await window.wumpy.chats.save({
        id: chatId,
        title,
        messages: chat.messages,
        tier
      })
      if (summary) {
        setChatTitle(summary.title)
        await refreshChats()
        chat.note(`Saved as **${summary.title}**.`)
      } else {
        chat.note('Could not save this chat.', true)
      }
    },
    [chat, chatId, tier, refreshChats]
  )

  const openChat = useCallback(
    async (id: string) => {
      const loaded = await window.wumpy.chats.load(id)
      if (!loaded) {
        chat.note('That chat could not be opened.', true)
        return
      }
      chat.replace(loaded.messages)
      setChatId(loaded.id)
      setChatTitle(loaded.title)
      setShowChats(false)
      setFocusToken((n) => n + 1)
    },
    [chat]
  )

  const setTier = useCallback(
    async (id: TierId) => {
      // Picking a tier follows its mode, so the theme always matches the tier.
      await patch({ tier: id, mode: TIERS[id].mode })
      void window.wumpy.tiers.warm(id).then(setTierStatuses)
    },
    [patch]
  )

  const toggleMode = useCallback(async () => {
    const next: Mode = mode === 'quick' ? 'dev' : 'quick'
    await patch({ mode: next, tier: defaultTierFor(next) })
    void window.wumpy.tiers.warm(defaultTierFor(next)).then(setTierStatuses)
  }, [mode, patch])

  /* --------------------------------------------------------------- commands */

  const runCommand = useCallback(
    async (action: CommandAction, raw: string): Promise<void> => {
      switch (action.kind) {
        case 'error':
          chat.note(action.message, true)
          return
        case 'info':
          chat.note(action.message)
          return
        case 'new':
          newChat()
          return
        case 'save':
          await saveChat(action.title)
          return
        case 'chats':
          await refreshChats()
          setShowChats(true)
          return
        case 'load': {
          await refreshChats()
          const list = await window.wumpy.chats.list()
          const q = action.query.toLowerCase()
          const hit = list.find((c) => c.title.toLowerCase().includes(q))
          if (hit) await openChat(hit.id)
          else chat.note(`No saved chat matching "${action.query}".`, true)
          return
        }
        case 'delete': {
          if (action.query.toLowerCase() === 'all') {
            const n = await window.wumpy.chats.delete('*')
            await refreshChats()
            chat.note(`Deleted ${n} saved chat${n === 1 ? '' : 's'}.`)
            return
          }
          const list = await window.wumpy.chats.list()
          const q = action.query.toLowerCase()
          const hit = list.find((c) => c.title.toLowerCase().includes(q))
          if (!hit) {
            chat.note(`No saved chat matching "${action.query}".`, true)
            return
          }
          await window.wumpy.chats.delete(hit.id)
          await refreshChats()
          chat.note(`Deleted **${hit.title}**.`)
          return
        }
        case 'rename':
          await saveChat(action.title)
          return
        case 'tier':
          await setTier(action.tier)
          chat.note(`Switched to **${TIERS[action.tier].label}**.`)
          return
        case 'mode': {
          const next: Mode = action.mode === 'toggle' ? (mode === 'quick' ? 'dev' : 'quick') : action.mode
          await patch({ mode: next, tier: defaultTierFor(next) })
          return
        }
        case 'dock':
          window.wumpy.panel.setDock(action.dock)
          setSettings((prev) => (prev ? { ...prev, dock: action.dock } : prev))
          return
        case 'reasoning': {
          const show =
            action.show === 'toggle' ? !(settings?.showReasoning ?? false) : action.show
          await patch({ showReasoning: show })
          chat.note(`Reasoning ${show ? 'shown' : 'hidden'}.`)
          return
        }
        case 'pin': {
          const next = action.pinned === 'toggle' ? !pinned : action.pinned
          setPinned(next)
          window.wumpy.panel.setPinned(next)
          return
        }
        case 'warm': {
          chat.note(`Preloading **${TIERS[tier].label}**…`)
          setTierStatuses(await window.wumpy.tiers.warm(tier))
          chat.note('Model is warm. Answers will start instantly.')
          return
        }
        case 'stop':
          chat.stop()
          return
        case 'help':
          chat.note(helpText())
          return
        case 'settings':
          chat.note('Opening the settings file from the tray menu → Open settings file.')
          return
        case 'quit':
          window.wumpy.panel.hide()
          return
        case 'prompt':
          chat.send(action.text, tier, raw)
          return
        case 'none':
          return
      }
    },
    [chat, mode, newChat, openChat, patch, pinned, refreshChats, saveChat, setTier, settings, tier]
  )

  const onSend = useCallback(
    (text: string) => {
      const action = parseCommand(text)
      if (action) {
        void runCommand(action, text)
        return
      }
      chat.send(text, tier)
    },
    [chat, runCommand, tier]
  )

  /* ------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (streaming) chat.stop()
        else if (showChats) setShowChats(false)
        else close()
        return
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Ctrl+1..4 jump straight to a tier, switching mode when needed.
        if (e.key >= '1' && e.key <= '4') {
          const order: TierId[] = ['flash', 'fast', 'thinker', 'deep']
          const picked = order[Number(e.key) - 1]
          if (picked) {
            e.preventDefault()
            void setTier(picked)
          }
          return
        }
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault()
          void toggleMode()
          return
        }
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault()
          newChat()
          return
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault()
          void saveChat()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat, close, newChat, saveChat, setTier, showChats, streaming, toggleMode])

  /* ----------------------------------------------------------------- scroll */

  /**
   * Pins the transcript to the bottom. Called both when messages change and on
   * every frame the revealed text grows, so the view tracks the smooth reveal
   * rather than jumping once per token.
   */
  const pinToBottom = useCallback(() => {
    const el = scroller.current
    if (!el || !stickToBottom.current) return
    // Instant, not smooth: the content now grows a character at a time, so a
    // direct set already reads as a smooth glide, while `behavior: 'smooth'`
    // would fight itself across frames.
    el.scrollTop = el.scrollHeight
  }, [])

  useLayoutEffect(pinToBottom, [messages, pinToBottom])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  /* ------------------------------------------------------------------ render */

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    window.wumpy.panel.setPinned(next)
  }

  const liveKey = hotkey.intercepted ?? hotkey.active
  const hotkeyLabel = liveKey ? prettify(liveKey) : 'tray only'
  const activeTier = TIERS[tier]
  const tierStatus = tierStatuses.find((t) => t.id === tier)
  const compact = !isTall(dock)

  return (
    <div
      className={`panel mode-${mode} dock-${dock} ${compact ? 'is-compact' : 'is-tall'} ${
        visible ? 'panel-in' : ''
      }`}
      data-theme={mode === 'dev' ? 'dark' : 'light'}
    >
      <Header
        mode={mode}
        onToggleMode={() => void toggleMode()}
        status={status}
        dock={dock}
        onCycleDock={(d) => {
          window.wumpy.panel.setDock(d)
          setSettings((prev) => (prev ? { ...prev, dock: d } : prev))
        }}
        pinned={pinned}
        onTogglePin={togglePin}
        onNewChat={newChat}
        onShowChats={() => {
          void refreshChats()
          setShowChats((v) => !v)
        }}
        onClose={close}
        hotkeyLabel={hotkeyLabel}
        title={chatTitle}
      />

      <TierBar
        mode={mode}
        tier={tier}
        statuses={tierStatuses}
        onPick={(id) => void setTier(id)}
      />

      {showChats ? (
        <ChatList
          chats={savedChats}
          activeId={chatId}
          onOpen={(id) => void openChat(id)}
          onDelete={async (id) => {
            await window.wumpy.chats.delete(id)
            await refreshChats()
          }}
          onClose={() => setShowChats(false)}
        />
      ) : (
        <div className="scroll" ref={scroller} onScroll={onScroll}>
          {messages.length === 0 ? (
            <Empty
              hotkeyLabel={hotkeyLabel}
              online={status?.reachable ?? false}
              tierLabel={activeTier.label}
              model={tierStatus?.resolvedModel ?? activeTier.model}
              installed={tierStatus?.installed ?? true}
              compact={compact}
            />
          ) : (
            messages.map((m, i) => (
              <Message
                key={m.id}
                message={m}
                streaming={streaming && i === messages.length - 1}
                showReasoning={settings?.showReasoning ?? false}
                onGrow={pinToBottom}
              />
            ))
          )}
        </div>
      )}

      <footer className="status">
        <span className="status-tier">{activeTier.label}</span>
        <span className="status-sep">·</span>
        <span>{tierStatus?.resolvedModel ?? 'no model'}</span>
        {streaming ? (
          <span className="status-live">generating…</span>
        ) : lastSpeed ? (
          <span className="status-live">
            {lastSpeed.toFixed(1)} tok/s
            {lastLoadMs !== null && lastLoadMs > 500 ? ` · ${(lastLoadMs / 1000).toFixed(1)}s load` : ''}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="status-tip">/ for commands</span>
      </footer>

      <Composer
        onSend={onSend}
        onStop={chat.stop}
        streaming={streaming}
        focusToken={focusToken}
        placeholder={
          mode === 'quick' ? 'Ask Wumpy…' : `Ask ${activeTier.label}… (slower, deeper)`
        }
      />
    </div>
  )
}

function Empty({
  hotkeyLabel,
  online,
  tierLabel,
  model,
  installed,
  compact
}: {
  hotkeyLabel: string
  online: boolean
  tierLabel: string
  model: string
  installed: boolean
  compact: boolean
}): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark">W</div>
      {!compact && <h1>Wumpy</h1>}
      {!online ? (
        <p>
          Can&rsquo;t reach Ollama. Start it with <code>ollama serve</code> and this panel will
          connect on its own.
        </p>
      ) : !installed ? (
        <p>
          No model installed for {tierLabel}. Run <code>ollama pull {model}</code>, then reopen.
        </p>
      ) : (
        <p>
          <strong>{tierLabel}</strong> on <code>{model}</code>. Press <kbd>{hotkeyLabel}</kbd>{' '}
          anywhere to summon this. Type <code>/</code> for commands.
        </p>
      )}
    </div>
  )
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ChatSummary,
  ContextUsage,
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
import { StatusBar } from './components/StatusBar'
import { Ambience } from './components/Ambience'
import logo from './assets/logo.png'
import { TierBar } from './components/TierBar'
import { ChatList } from './components/ChatList'

/** Mirrors the main process's accelerator formatting for display. */
function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}

export default function App(): React.JSX.Element {
  const chat = useChat()
  const { messages, streaming, stats } = chat

  const [settings, setSettings] = useState<WumpySettings | null>(null)
  const [tierStatuses, setTierStatuses] = useState<TierStatus[]>([])
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [hotkey, setHotkey] = useState<HotkeyState>({
    active: null,
    failed: [],
    intercepted: null
  })
  // "Pinned" is the inverse of hideOnBlur, and persists: the panel is meant to
  // stay on top of whatever you are working in until you dismiss it.
  const pinned = !(settings?.hideOnBlur ?? false)
  const [visible, setVisible] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  /** Advances every time the panel is summoned, so one-shot effects replay. */
  const [openCount, setOpenCount] = useState(0)

  // Saved chats
  const [showChats, setShowChats] = useState(false)
  const [savedChats, setSavedChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string>(() => nextId())
  const [chatTitle, setChatTitle] = useState<string | null>(null)
  /** Set once the user renames, so automatic titling stops touching it. */
  const [titleLocked, setTitleLocked] = useState(false)

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
    const raf = requestAnimationFrame(() => {
      setVisible(true)
      setOpenCount((n) => n + 1)
    })
    const off = window.wumpy.panel.onShown(() => {
      setVisible(true)
      setOpenCount((n) => n + 1)
      setFocusToken((n) => n + 1)
    })
    return () => {
      cancelAnimationFrame(raf)
      off()
    }
  }, [])

  /**
   * Electron marks a hidden window as hidden to the page, which is the only
   * signal the renderer gets when the hotkey dismisses the panel. Without
   * resetting here the open animation would play once per launch instead of
   * once per summon.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) setVisible(false)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
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
    const fresh = nextId()
    setChatId(fresh)
    setChatTitle(null)
    setTitleLocked(false)
    // A fresh chat is eligible for automatic titling again.
    titledFor.current = null
    setShowChats(false)
  }, [chat])

  const retitle = useCallback(
    async (title?: string) => {
      if (chat.messages.length === 0) {
        chat.note('Nothing to retitle yet.', true)
        return
      }
      const summary = await window.wumpy.chats.save({
        id: chatId,
        title,
        messages: chat.messages,
        tier,
        titleLocked: true
      })
      if (summary) {
        setChatTitle(summary.title)
        setTitleLocked(true)
        await refreshChats()
        chat.note(`Retitled to **${summary.title}**.`)
      } else {
        chat.note('Could not retitle this chat.', true)
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
      setTitleLocked(loaded.titleLocked ?? false)
      // Already named, so do not re-title it on the next turn.
      titledFor.current = loaded.id
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

  /* --------------------------------------------------- autosave + compaction */

  /** Character-based fallback, used until Ollama reports real counts. */
  const estimateTokens = useCallback(
    () => Math.ceil(chat.history().reduce((n, m) => n + m.content.length, 0) / 4),
    [chat]
  )

  /**
   * What the context meter shows. Ollama's counts are exact but only arrive
   * after a turn completes, so the estimate covers the gap — including the
   * message being typed, which has not been sent yet.
   */
  const usage: ContextUsage = (() => {
    const limit = TIERS[tier].options.num_ctx
    const counted = stats.contextTokens
    const estimate = estimateTokens()
    // After a turn lands, the counted value is authoritative. Before the first
    // turn, or after loading a saved chat, fall back to characters.
    if (counted !== null && counted >= estimate * 0.5) {
      return { used: counted, limit, estimated: false }
    }
    return { used: estimate, limit, estimated: true }
  })()

  /**
   * Replaces all but the most recent turns with a model-written summary, so a
   * long conversation keeps fitting in the context window.
   */
  const compactHistory = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      const msgs = chat.messages.filter((m) => !m.error && !m.local)
      // Keep the last few turns verbatim; summarising those loses the thread.
      const keep = 4
      if (msgs.length <= keep + 1) {
        if (!opts.silent) chat.note('Not enough history to compact yet.')
        return false
      }

      const older = msgs.slice(0, msgs.length - keep)
      const recent = msgs.slice(msgs.length - keep)
      if (!opts.silent) chat.note('Compacting earlier turns…')

      const summary = await window.wumpy.chat.compact({
        tier,
        messages: older.map((m) => ({
          role: m.summary ? 'system' : m.role,
          content: m.content
        }))
      })

      if (!summary) {
        if (!opts.silent) chat.note('Could not compact this conversation.', true)
        return false
      }

      chat.replace([
        {
          id: nextId(),
          role: 'assistant',
          content: summary,
          createdAt: Date.now(),
          summary: true,
          summarised: older.length
        },
        ...recent
      ])
      return true
    },
    [chat, tier]
  )

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

        case 'chats':
          await refreshChats()
          setShowChats(true)
          return
        case 'resume': {
          await refreshChats()
          setShowChats(true)
          return
        }
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
          await retitle(action.title)
          return
        case 'tier': {
          const kept = chat.history().length
          await setTier(action.tier)
          chat.note(
            `Switched to **${TIERS[action.tier].label}**` +
              (kept > 0 ? ` — carrying ${kept} message${kept === 1 ? '' : 's'} of context.` : '.')
          )
          return
        }
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
          await patch({ hideOnBlur: !next })
          chat.note(next ? 'Staying on top until dismissed.' : 'Will hide when it loses focus.')
          return
        }
        case 'compact': {
          await compactHistory()
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
    [chat, mode, newChat, openChat, patch, pinned, refreshChats, retitle, setTier, settings, tier]
  )

  const onSend = useCallback(
    (text: string) => {
      const action = parseCommand(text)
      if (action) {
        void runCommand(action, text)
        return
      }

      // Compact before sending when the context is filling up, so the model
      // never silently loses the start of the conversation.
      const budget = TIERS[tier].options.num_ctx * 0.65
      if ((settings?.autoCompact ?? true) && usage.used > budget) {
        void (async () => {
          const done = await compactHistory({ silent: true })
          if (done) chat.note('Compacted earlier turns to make room.')
          chat.send(text, tier)
        })()
        return
      }

      chat.send(text, tier)
    },
    [chat, compactHistory, runCommand, settings, tier, usage.used]
  )

  /**
   * Names the chat from its opening exchange, once, in the background.
   *
   * The store seeds a title from the first user line so the sidebar is never
   * blank, and this upgrades it to something the model wrote. A rename locks
   * the title and stops this from running.
   */
  const titledFor = useRef<string | null>(null)
  useEffect(() => {
    if (streaming || titleLocked) return
    if (titledFor.current === chatId) return

    const real = chat.messages.filter((m) => !m.local && !m.error)
    const answered = real.some((m) => m.role === 'assistant' && m.content.trim())
    if (!answered) return

    // Mark first: this must run at most once per chat even if the effect
    // re-fires while the request is in flight.
    titledFor.current = chatId
    void window.wumpy.chat
      .title({ messages: real.map((m) => ({ role: m.role as string, content: m.content })) })
      .then((title) => {
        if (!title) return
        setChatTitle(title)
        void window.wumpy.chats
          .save({ id: chatId, title, messages: chat.messages, tier })
          .then(() => refreshChats())
      })
  }, [chat.messages, chatId, refreshChats, streaming, tier, titleLocked])

  /**
   * Persists the conversation whenever it settles. Debounced and keyed on the
   * message count so a stream of tokens does not write a file per frame.
   */
  useEffect(() => {
    if (!(settings?.autoSave ?? true)) return
    if (streaming) return
    const real = chat.messages.filter((m) => !m.local)
    if (real.length === 0) return

    const timer = setTimeout(() => {
      void window.wumpy.chats
        .save({
          id: chatId,
          title: chatTitle ?? undefined,
          messages: chat.messages,
          tier,
          titleLocked
        })
        .then((summary) => {
          if (!summary) return
          if (!chatTitle) setChatTitle(summary.title)
          void refreshChats()
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [chat.messages, chatId, chatTitle, refreshChats, settings, streaming, tier, titleLocked])

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
        if (e.key.toLowerCase() === 'r') {
          e.preventDefault()
          void refreshChats()
          setShowChats(true)
          return
        }

      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat, close, newChat, retitle, setTier, showChats, streaming, toggleMode])

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
    void patch({ hideOnBlur: !next })
    // Toggling this has no visible effect until focus moves, so say what changed.
    chat.note(
      next
        ? 'Pinned — staying on top until you dismiss it.'
        : 'Unpinned — will hide when it loses focus.'
    )
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
      <Ambience mode={mode} active={visible} openCount={openCount} />

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

      <StatusBar
        tierLabel={activeTier.label}
        model={tierStatus?.resolvedModel ?? 'no model'}
        streaming={streaming}
        stats={stats}
        usage={usage}
        compact={compact}
        onCompact={() => void compactHistory()}
      />

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
      <img className="empty-mark" src={logo} alt="" width={48} height={48} />
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

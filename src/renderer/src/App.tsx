import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatSummary,
  ContextUsage,
  Dock,
  HotkeyState,
  AssistantStatus,
  ApprovalMode,
  ShellKind,
  ShellResult,
  LinkResult,
  WriteResult,
  SearchResult,
  KeyStatus,
  WumpySettings
} from '@shared/types'
import { isTall } from '@shared/types'
import { looksLikeUrl, SEARCH_ENGINES, type LinkApproval } from '@shared/links'
import { clippedOutput, commandFeedback } from '@shared/parsefail'
import { CONTEXT_TOKENS, DEFAULT_MODEL } from '@shared/assistant'
import { shouldRetitle } from '@shared/titles'
import { CLOUD_MODELS, PROVIDERS } from '@shared/cloud'
import { useChat, nextId, type ChatStats } from './hooks/useChat'
import {
  allCommands,
  parseCommand,
  helpText,
  KEY_ONLY,
  SHORTCUT_FOR,
  type CommandAction
} from './commands'
import { newestPending } from './pending'
import { forgetClaims } from './once'
import { forgetAllLive } from './live'
import { forgetActions, record } from './ledger'
import { matchIntent } from './intents'
import { AUTO_RUN_LIMIT, autoRunEligible } from './autorun'
import { DOCK_CYCLE, Header } from './components/Header'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import logo from './assets/logo.png'
import { Picker, type PickerProps } from './components/Picker'

/** Mirrors the main process's accelerator formatting for display. */
function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}

const NEWLINE = String.fromCharCode(10)

export default function App(): React.JSX.Element {
  const chat = useChat()
  const { messages, streaming, streamingId, stats } = chat

  const [settings, setSettings] = useState<WumpySettings | null>(null)
  const [assistant, setAssistant] = useState<AssistantStatus | null>(null)
  /** Which providers have a key. Never the keys themselves. */
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
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
  /**
   * A message typed while a turn was running.
   *
   * It used to be dropped: Enter did nothing, the text stayed in the box, and
   * nothing said why. One is held at a time - a second replaces it, because
   * what you meant to say next is the last thing you typed.
   */
  const [queued, setQueued] = useState<string | null>(null)
  /** Text the command menu has dropped into the composer, with a bump token. */
  const [prefill, setPrefillState] = useState({ text: '', token: 0 })
  const setPrefill = useCallback((text: string) => {
    setPrefillState((p) => ({ text, token: p.token + 1 }))
  }, [])

  // Saved chats
  /** Which picker is open, if any. One list UI serves them all. */
  const [picker, setPicker] = useState<
    null | 'command' | 'resume' | 'delete' | 'model' | 'dock' | 'engine'
  >(null)
  const [savedChats, setSavedChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string>(() => nextId())
  const [chatTitle, setChatTitle] = useState<string | null>(null)
  /** Set once the user renames, so automatic titling stops touching it. */
  const [titleLocked, setTitleLocked] = useState(false)

  const scroller = useRef<HTMLDivElement>(null)
  /** False once the user scrolls up, so streaming does not yank them back down. */
  const stickToBottom = useRef(true)
  /** Mirrors it for the "jump to latest" button, which needs a re-render. */
  const [atBottom, setAtBottom] = useState(true)

  const model: string = settings?.model ?? DEFAULT_MODEL
  const dock: Dock = settings?.dock ?? 'right'

  /* ------------------------------------------------------------- bootstrap */

  useEffect(() => {
    void window.wumpy.settings.get().then(setSettings)
    void window.wumpy.hotkey.get().then(setHotkey)
    void window.wumpy.assistant.status().then(setAssistant)
    void window.wumpy.keys.status().then(setKeyStatus)
    void window.wumpy.chats.list().then(setSavedChats)
    return window.wumpy.hotkey.onChange(setHotkey)
  }, [])

  useEffect(() => window.wumpy.assistant.onStatus(setAssistant), [])

  // The tray menu can change approval mode and the rest from outside the panel.
  useEffect(() => window.wumpy.settings.onChange(setSettings), [])
  useEffect(
    () =>
      window.wumpy.panel.onDock((d) => setSettings((prev) => (prev ? { ...prev, dock: d } : prev))),
    []
  )

  // Trigger the slide-in on mount and on every hotkey press.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    const off = window.wumpy.panel.onShown(() => {
      setVisible(true)
      setFocusToken((n) => n + 1)
    })

    /**
     * The panel coming back to the front also puts the caret in the box.
     *
     * panelShown only fires when the main process shows the window. Clicking
     * back to a panel that was already open, or returning to it after
     * Alt+Tab, does not go through that path - and until now you arrived at a
     * window with nothing focused and had to click before you could type.
     *
     * Only when nothing in the page holds focus, so stepping into a card and
     * switching away briefly does not lose your place, and only when no
     * picker is open, since a picker focuses its own filter.
     */
    const onWindowFocus = (): void => {
      const active = document.activeElement
      if (active && active !== document.body) return
      if (document.querySelector('.picker')) return
      setFocusToken((n) => n + 1)
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('focus', onWindowFocus)
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

  // Keep the model's view of the app current. In an effect rather than in the
  // render body, which would write to a ref during render.
  useEffect(() => {
    chat.setContext({ chatTitle })
  }, [chat, chatTitle])

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
    // The claims are per message id, and a new conversation has none of the
    // old ones. Left to grow they would also outlive every chat in the
    // session for no reason.
    forgetClaims()
    forgetAllLive()
    forgetActions()
    const fresh = nextId()
    setChatId(fresh)
    setChatTitle(null)
    setTitleLocked(false)
    // A fresh chat is eligible for automatic titling again.
    titledFor.current = null
    setPicker(null)
  }, [chat])

  /**
   * Renames the current chat.
   *
   * The title changes on screen in the same frame. Persisting it used to be
   * awaited first, and persisting meant shipping every message over IPC,
   * rewriting the file and then re-reading every other saved chat to refresh
   * the picker — all before the one thing the user asked for appeared. None of
   * that needs to happen first, so none of it does.
   */
  const retitle = useCallback(
    (title?: string) => {
      const next = title?.trim()
      if (!next) {
        chat.note('Give it a name: `/rename Something`.', true)
        return
      }
      if (chat.messages.length === 0) {
        chat.note('Nothing to retitle yet.', true)
        return
      }

      setChatTitle(next)
      setTitleLocked(true)

      void (async () => {
        // `rename` only rewrites the title field. It returns null when the chat
        // has not been written yet, which happens inside the autosave debounce.
        const renamed = await window.wumpy.chats.rename(chatId, next)
        if (!renamed) {
          await window.wumpy.chats.save({
            id: chatId,
            title: next,
            messages: chat.messages,
            titleLocked: true
          })
        }
        void refreshChats()
      })()
    },
    [chat, chatId, refreshChats]
  )

  const openChat = useCallback(
    async (id: string) => {
      const loaded = await window.wumpy.chats.load(id)
      if (!loaded) {
        chat.note('That chat could not be opened.', true)
        return
      }
      chat.replace(loaded.messages)
      // A reopened chat brings back proposals whose ids were claimed when
      // they first ran. Without this it would find them all already done and
      // refuse to act on any of them.
      forgetClaims()
      forgetAllLive()
      forgetActions()
      setChatId(loaded.id)
      setChatTitle(loaded.title)
      setTitleLocked(loaded.titleLocked ?? false)
      // Already named, at however many turns it holds - so it is next renamed
      // at the threshold above that, not on the very next message. Counted
      // the same way the titling effect counts, or the two disagree.
      titledFor.current = {
        chat: loaded.id,
        turns: loaded.messages.filter((m) => !m.local && !m.error && m.role === 'user').length
      }
      setPicker(null)
      setFocusToken((n) => n + 1)
    },
    [chat]
  )

  /* -------------------------------------------------------------- commands */

  /** Whether Wumpy may propose commands at all. */
  const canRunCommands = settings?.shellEnabled ?? true

  /**
   * The latest chat state, for callbacks that must not change identity.
   *
   * `chat` is a fresh object every render and `messages` changes on every
   * token, so a callback listing it as a dependency was rebuilt per token.
   * Three of those are handed to every Message, which defeated the memo whose
   * whole job is to stop the transcript re-parsing its markdown each time — so
   * the panel's cost per token grew with the length of the conversation,
   * during the one period when the cores are wanted elsewhere.
   */
  const chatRef = useRef(chat)
  chatRef.current = chat
  const retitleRef = useRef(retitle)
  retitleRef.current = retitle

  /** The user picked one of the model's options: lock the card and reply with it. */
  const onAnswerQuestion = useCallback((messageId: string, option: string) => {
    const live = chatRef.current
    live.recordAnswer(messageId, option)
    const asked = live.messages.find((m) => m.id === messageId)?.localAsk
    if (asked?.kind === 'rename') {
      // Wumpy asked this one itself, so act on it rather than replying.
      retitleRef.current(option)
      return
    }
    live.send(option)
  }, [])

  const canSearch = settings?.searchEnabled ?? true

  const runSearch = useCallback((query: string) => window.wumpy.search.run(query), [])

  /** Hands search results back so the model can answer from them. */
  const onSearchResults = useCallback(
    (query: string, results: SearchResult[], provider: string, error?: string) => {
      if (!error) record('search', query)
      const body = error
        ? `The search failed: ${error}`
        : results
            .map((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, `   ${r.snippet}`].join('\n'))
            .join('\n')
      chatRef.current.send(
        [
          `Results for "${query}" (via ${provider}):`,
          '',
          body,
          '',
          'Answer the original question from these. Cite the sources you used.'
        ].join('\n'),
        `Searched: ${query}`
      )
    },
    []
  )

  /* ------------------------------------------------------------- file writes */

  const writeFile = useCallback(
    (path: string, content: string) => window.wumpy.files.write(path, content),
    []
  )
  const checkWrite = useCallback((path: string) => window.wumpy.files.check(path), [])

  /**
   * Notes what was written, without telling the model the contents back.
   *
   * It just wrote them. Feeding a file's text back as a result invited it to
   * review its own output and "correct" it, which is the loop these cards exist
   * to break.
   */
  const onWritten = useCallback((result: WriteResult) => {
    if (result.written) record('write', result.path)
    chatRef.current.note(
      result.written
        ? `${result.overwrote ? 'Replaced' : 'Created'} \`${result.path}\` (${result.bytes} bytes).`
        : `Could not write that file: ${result.error ?? 'unknown error'}`
    )
  }, [])

  /* ----------------------------------------------------------------- browser */

  const canOpenLinks = settings?.browserEnabled ?? true

  /**
   * How much a proposed link may do on its own.
   *
   * Mapped from the approval mode the user already set for commands, rather than
   * being its own switch: "how much happens without me" is one question, and
   * answering it twice in two places is how the two end up disagreeing. What the
   * modes mean for a link is decided in shared/links.ts.
   */
  const linkMode: LinkApproval = settings?.approvalMode ?? 'manual'

  const openLink = useCallback((url: string) => window.wumpy.links.open(url), [])
  const openSearch = useCallback((query: string) => window.wumpy.links.search(query), [])

  /**
   * Records what was opened, in the transcript rather than back to the model.
   *
   * A page in the browser is not something the model can read, so there is
   * nothing to report to it - and telling it "opened example.com" invited it to
   * narrate what the page said, which it could not possibly know.
   */
  const onOpened = useCallback((result: LinkResult) => {
    if (result.opened) record('open', result.host)
    chatRef.current.note(
      result.opened
        ? `Opened **${result.host}** in your browser.`
        : `Could not open that: ${result.error ?? 'unknown error'}`
    )
  }, [])

  /**
   * How many commands have run unattended since the user last typed.
   *
   * Automatic modes can otherwise loop: a command runs, its output goes back to
   * the model, the model proposes another. After a handful without a person in
   * the loop, cards stop running themselves and wait.
   */
  const [autoRuns, setAutoRuns] = useState(0)
  const autoAllowed = autoRuns < AUTO_RUN_LIMIT

  /**
   * The unattended-run budget, kept in refs rather than in state.
   *
   * These are read to decide whether to run something, which happens in an
   * effect the moment a card appears. State updates land on the next render, so
   * several cards deciding in the same tick all read the same empty list and
   * all ran — the de-duplication was there and simply never saw itself. A ref
   * is written the instant a card claims a run, so the next card sees it.
   */
  const autoRunsRef = useRef(0)
  const ranCommandsRef = useRef<string[]>([])
  /** One unattended run per assistant message, whatever it proposes. */
  const ranByMessage = useRef(new Set<string>())

  /**
   * Asks for permission to run unattended and takes it in the same breath.
   *
   * Deliberately not a pure predicate: a card that is told yes has, by that
   * answer, spent the budget. Anything that merely reports eligibility can be
   * asked twice.
   */
  const claimAutoRun = useCallback((command: string, messageId: string): boolean => {
    if (messageId && ranByMessage.current.has(messageId)) return false
    const ok = autoRunEligible({
      command,
      ranCommands: ranCommandsRef.current,
      autoRuns: autoRunsRef.current
    })
    if (!ok) return false
    if (messageId) ranByMessage.current.add(messageId)
    ranCommandsRef.current.push(command.trim())
    autoRunsRef.current += 1
    setAutoRuns(autoRunsRef.current)
    return true
  }, [])

  /**
   * Message ids generated during this session.
   *
   * Reopening a saved chat re-mounts every card it contains, and those are
   * finished messages, so without this an automatic mode would run the whole
   * transcript again on load.
   */
  const generated = useRef(new Set<string>())
  useEffect(() => {
    if (streamingId) generated.current.add(streamingId)
  }, [streamingId])

  const runShellCommand = useCallback(
    (command: string, shellKind: ShellKind, runId?: string) =>
      window.wumpy.shell.run({ command, shell: shellKind, runId }),
    []
  )

  /**
   * Hands a command's output back to the model so it can carry on.
   *
   * Output is trimmed hard before it goes in: a directory listing can easily
   * outweigh the whole conversation, and on a 2-8k context window that would
   * push the actual question out of scope.
   */
  const onCommandResult = useCallback((result: ShellResult, unattended: boolean) => {
    // Recorded by the code that ran it, before anything is interpreted. The
    // model is never asked to remember whether it acted.
    record('command', result.command)
    // Only runs that happened without a click spend the budget; approving one
    // by hand is the person being present, which is what the budget protects.
    // An unattended run already spent its budget when it claimed the slot.
    // A click does not spend budget, but the command still counts as run, so
    // the model cannot have it repeated automatically afterwards.
    if (!unattended) ranCommandsRef.current.push(result.command.trim())
    /**
     * One definition of this report, in shared, because bench-ceiling now
     * grades what the model says after reading the output - and a benchmark
     * that writes its own version of the report measures a conversation the
     * app never has.
     */
    const feedback = commandFeedback(result)
    if (feedback.kind === 'notice') {
      chatRef.current.notice(feedback.text)
      return
    }
    const report = feedback.text

    // Sent as a user turn because that is the role the model expects a tool
    // result to arrive in, but shown as the short line instead of the dump.
    const sent = chatRef.current.send(report, `Ran: \`${result.command}\``)
    // A turn was already in flight, so the output would otherwise vanish.
    // It still reaches the model, just as a fact rather than a question.
    if (!sent) {
      chatRef.current.notice(
        `Ran \`${result.command}\`:\n${clippedOutput(result) || '(no output)'}`
      )
    }
  }, [])

  /* --------------------------------------------------- autosave + compaction */

  /**
   * Character-based fallback, used until the provider reports real counts.
   *
   * Memoised because it walks every message, and the panel re-renders on every
   * token: without this, the cost of counting the conversation was paid once
   * per token and grew with the conversation, while the model was generating.
   */
  const estimateTokens = useMemo(
    () =>
      Math.ceil(messages.reduce((n, m) => (m.error || m.local ? n : n + m.content.length), 0) / 4),
    [messages]
  )

  /**
   * What the context meter shows. The provider's counts are exact but only
   * arrive after a turn completes, so the estimate covers the gap — including
   * the message being typed, which has not been sent yet.
   */
  /**
   * Whether the model in use writes ```powershell where Wumpy asks for
   * ```wumpy-run. Declared in CLOUD_MODELS rather than guessed, so a model
   * that complies is never second-guessed. See normaliseFences.
   */
  const looseFences = CLOUD_MODELS.some((m) => m.id === model && m.looseFences)

  const usage: ContextUsage = (() => {
    const limit = CONTEXT_TOKENS
    const counted = stats.contextTokens
    const estimate = estimateTokens
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
    [chat]
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
          setPicker('resume')
          return
        case 'resume': {
          await refreshChats()
          setPicker('resume')
          return
        }
        case 'delete': {
          await refreshChats()
          setPicker('delete')
          return
        }
        case 'rename':
          retitle(action.title)
          return
        case 'renameChoice':
          // Both readings are plausible; one click settles it, with no model.
          chat.askLocal(action.question, action.options, 'rename')
          return
        case 'dock': {
          if (!action.dock) {
            setPicker('dock')
            return
          }
          const next = action.dock
          window.wumpy.panel.setDock(next)
          setSettings((prev) => (prev ? { ...prev, dock: next } : prev))
          return
        }
        case 'model': {
          if (!action.name) {
            setPicker('model')
            return
          }

          // Named directly. A hosted model needs its key first, and a local
          // one has to be installed; anything else would set a tier that
          // cannot answer and fail at the next question instead of here.
          const wanted = action.name
          const hosted = CLOUD_MODELS.find(
            (m) => m.id === wanted || m.label.toLowerCase() === wanted.toLowerCase()
          )
          const id = hosted?.id ?? wanted

          if (hosted && !(keyStatus?.configured.includes(hosted.provider) ?? false)) {
            chat.note(
              `**${hosted.label}** needs a ${PROVIDERS[hosted.provider].label} key. ` +
                `Add one with \`/key ${hosted.provider} <key>\`.`
            )
            return
          }

          await patch({ model: id })
          void window.wumpy.assistant.status().then(setAssistant)
          chat.note(`Now answering with \`${id}\`.`)
          return
        }
        case 'reasoning': {
          const show = action.show === 'toggle' ? !(settings?.showReasoning ?? false) : action.show
          await patch({ showReasoning: show })
          chat.note(`Reasoning ${show ? 'shown' : 'hidden'}.`)
          return
        }
        /**
         * The user asking for a page directly.
         *
         * No card and no approval: they typed it, which is the approval. A model
         * proposing the same thing goes through LinkCard, because the difference
         * between the two is the whole point of the gate.
         *
         * Either a link or words - "github.com/psyduck-z" opens, "best pizza"
         * searches - because having to remember which command takes which is
         * friction for no safety.
         */
        case 'open': {
          const result = looksLikeUrl(action.what)
            ? await window.wumpy.links.open(action.what)
            : await window.wumpy.links.search(action.what)
          chat.note(
            result.opened
              ? `Opened **${result.host}**.`
              : `Could not open that: ${result.error ?? 'unknown error'}`
          )
          return
        }
        case 'engine':
          setPicker('engine')
          return
        case 'usage': {
          const report = action.reset
            ? await window.wumpy.usage.reset()
            : await window.wumpy.usage.get()

          if (!report.lines.length) {
            chat.note(
              action.reset
                ? 'Usage cleared.'
                : `Nothing used yet today. Answering with \`${report.model}\`.`
            )
            return
          }

          const rows = report.lines.map((l) => {
            const rate = l.tokensPerSecond ? `${l.tokensPerSecond.toFixed(0)} tok/s` : '—'
            /**
             * A dash said nothing useful.
             *
             * Most of these models have no published daily cap worth
             * trusting, so there is no percentage to show - but the count and
             * the per-minute ceiling are both known, and that is what someone
             * asking "how much have I got left" actually wants to see.
             */
            const used =
              l.usedFraction !== null
                ? `${Math.round(l.usedFraction * 100)}% of today`
                : l.via === 'local'
                  ? 'unlimited'
                  : `${l.requests} so far, cap unknown`
            const trouble = [
              l.limited ? `${l.limited} rate limited` : '',
              l.errors - l.limited > 0 ? `${l.errors - l.limited} failed` : ''
            ]
              .filter(Boolean)
              .join(', ')
            return (
              `| ${l.model} | ${l.via} | ${l.requests} | ${l.tokens.toLocaleString()}` +
              `${l.thinking ? ` (${l.thinking.toLocaleString()} thinking)` : ''} | ${rate} | ` +
              `${used}${trouble ? ` · ${trouble}` : ''} |`
            )
          })

          chat.note(
            [
              `**Today (${report.date})** — answering with \`${report.model}\``,
              '',
              '| model | via | turns | tokens | speed | quota |',
              '| --- | --- | --- | --- | --- | --- |',
              ...rows,
              '',
              ...report.lines.filter((l) => l.note).map((l) => `_${l.model}: ${l.note}_`)
            ].join(String.fromCharCode(10))
          )
          return
        }
        case 'remember': {
          if (action.clear) {
            const result = await window.wumpy.context.set('', false)
            chat.note(result.ok ? 'Forgot everything in the notes.' : result.why)
            return
          }
          if (!action.value) {
            const current = await window.wumpy.context.get()
            chat.note(
              current.text
                ? `Wumpy is carrying this into every chat:${NEWLINE}${NEWLINE}${current.text}` +
                    `${NEWLINE}${NEWLINE}The file is at ${current.path}. ` +
                    'Add with `/remember <thing>`, wipe it with `/remember clear`.' +
                    (current.truncated ? ' It is longer than Wumpy sends — trim it.' : '')
                : 'Nothing remembered yet. `/remember I prefer celsius` and it will ' +
                    'be there in every chat from now on.'
            )
            return
          }
          const result = await window.wumpy.context.set(action.value, true)
          chat.note(
            result.ok
              ? `Noted, and it will be there in the next chat too.` +
                  (result.truncated
                    ? ' The notes are now longer than Wumpy sends — trim them.'
                    : '')
              : result.why
          )
          return
        }
        case 'key': {
          const provider = action.provider
          if (!provider) return
          const label = PROVIDERS[provider].label

          if (action.clear) {
            const result = await window.wumpy.keys.clear(provider)
            setKeyStatus(await window.wumpy.keys.status())
            void window.wumpy.assistant.status().then(setAssistant)
            chat.note(result.ok ? `Forgot the ${label} key.` : result.why)
            return
          }

          if (!action.value) {
            const status = await window.wumpy.keys.status()
            if (!status.canStore) {
              chat.note('This PC cannot store a key securely, so Wumpy will not store one at all.')
              return
            }
            const has = status.configured.includes(provider)
            chat.note(
              has
                ? `${status.counts?.[provider] ?? 1} ${label} key(s) saved. Add another with ` +
                    `\`/key ${provider} add <key>\`, replace them all with ` +
                    `\`/key ${provider} <key…>\`, or remove them with \`/key ${provider} clear\`.`
                : `No ${label} key yet. Get one at ${PROVIDERS[provider].keyUrl} ` +
                    `and paste it with \`/key ${provider} <key>\`.`
            )
            return
          }

          const result = action.add
            ? await window.wumpy.keys.add(provider, action.value)
            : await window.wumpy.keys.set(provider, action.value)
          setKeyStatus(await window.wumpy.keys.status())
          void window.wumpy.assistant.status().then(setAssistant)
          /**
           * Says how many are stored, because several is the normal case.
           * Google's free tier allows five requests a minute PER PROJECT,
           * so keys from separate projects multiply the rate and keys from
           * the same one do not - and the count is the only feedback that
           * the paste landed as several rather than one.
           */
          const total = result.total ?? 1
          chat.note(
            result.ok
              ? `${action.add ? 'Added' : 'Saved'} the ${label} key${total === 1 ? '' : 's'}, ` +
                  `encrypted for this Windows account. ${total} stored` +
                  (total > 1 ? ', used in turn so each limit counts separately. ' : '. ') +
                  'Pick a model with `/model`.'
              : result.why
          )
          return
        }
        case 'voice': {
          if (action.setting === 'on') {
            const next = action.on === 'toggle' ? !settings?.voiceEnabled : action.on
            await patch({ voiceEnabled: next })
            chat.note(
              next
                ? 'Voice input on. **Hold the spacebar** for half a second and talk — let go to ' +
                    'send it to the box. Ctrl+M does the same without holding.'
                : 'Voice input off. The spacebar is just a spacebar again.'
            )
            return
          }
          if (action.setting === 'polish') {
            const next = action.on === 'toggle' ? !settings?.voicePolish : action.on
            await patch({ voicePolish: next })
            chat.note(
              next
                ? 'Dictation will be punctuated by the local model. The app’s own vocabulary ' +
                    'is fixed either way.'
                : 'Dictation goes in as heard, with only the vocabulary table applied.'
            )
            return
          }
          const next = action.on === 'toggle' ? !settings?.voiceAutoStop : action.on
          await patch({ voiceAutoStop: next })
          chat.note(
            next
              ? 'Dictation stops when you stop talking.'
              : 'Dictation runs until you press Ctrl+M again.'
          )
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
        case 'approve': {
          const order: ApprovalMode[] = ['manual', 'auto', 'all']
          const current = settings?.approvalMode ?? 'manual'
          const next =
            action.mode === 'cycle'
              ? order[(order.indexOf(current) + 1) % order.length]
              : action.mode
          await patch({ approvalMode: next })
          setAutoRuns(0)
          autoRunsRef.current = 0
          ranCommandsRef.current = []
          chat.note(APPROVAL_NOTE[next])
          return
        }
        case 'stop':
          chat.stop()
          return
        case 'help':
          chat.note(helpText())
          return
        case 'quit':
          window.wumpy.panel.hide()
          return
        case 'prompt':
          chat.send(action.text, raw)
          return
        case 'none':
          return
      }
    },
    [chat, newChat, openChat, patch, pinned, refreshChats, retitle, settings]
  )

  const onSend = useCallback(
    (text: string) => {
      // Typing is the person rejoining the loop, so the unattended budget and
      // the already-ran list start again — whichever path the message takes
      // from here, including the auto-compact one that used to skip the reset.
      setAutoRuns(0)
      autoRunsRef.current = 0
      ranCommandsRef.current = []

      // Something said while the model is still writing. /also is for when the
      // answer is going the right way and you have one more fact to add: the
      // turn carries on, and the note is in front of the model from the next
      // one. Anything else waits its turn rather than being thrown away.
      if (streaming) {
        const aside = /^\/also\b\s*([\s\S]*)$/i.exec(text.trim())
        if (aside) {
          const body = aside[1].trim()
          if (!body) chat.note('Usage: `/also <something to add>` while an answer is running.')
          else chat.aside(body)
          return
        }
        /**
         * A command is an instruction to Wumpy, not a message for the model, so
         * it happens now rather than waiting in line. Queuing them meant `/stop`
         * sat behind the answer it was meant to stop, which is the one moment
         * someone is most likely to type it.
         */
        const command = parseCommand(text)
        if (command) {
          void runCommand(command, text)
          return
        }

        setQueued(text)
        return
      }

      const action = parseCommand(text)
      if (action) {
        void runCommand(action, text)
        return
      }

      // "rename this chat to X" and friends are things Wumpy does itself. Asking
      // a model costs six seconds to be told a command, or on a reasoning tier
      // two minutes to be told nothing at all.
      const intent = matchIntent(text)
      if (intent) {
        void runCommand(intent, text)
        return
      }

      // Compact before sending when the context is filling up, so the model
      // never silently loses the start of the conversation.
      const budget = CONTEXT_TOKENS * 0.65
      if ((settings?.autoCompact ?? true) && usage.used > budget) {
        void (async () => {
          const done = await compactHistory({ silent: true })
          if (done) chat.note('Compacted earlier turns to make room.')
          chat.send(text)
        })()
        return
      }

      chat.send(text)
    },
    [chat, compactHistory, runCommand, settings, streaming, usage.used]
  )

  /**
   * Sends what was typed during the last answer, once that answer has landed.
   *
   * A frame later, so the turn that just finished has settled its state before
   * the next one starts from it.
   */
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  useEffect(() => {
    if (streaming || !queued) return
    const text = queued
    setQueued(null)
    const timer = setTimeout(() => onSendRef.current(text), 60)
    return () => clearTimeout(timer)
  }, [streaming, queued])

  /**
   * Names the chat from its opening exchange, once, in the background.
   *
   * The store seeds a title from the first user line so the sidebar is never
   * blank, and this upgrades it to something the model wrote. A rename locks
   * the title and stops this from running.
   */
  const titledFor = useRef<{ chat: string; turns: number } | null>(null)
  /**
   * Mirrors `titleLocked` for the async callback below. The effect's own copy is
   * captured when the request goes out, but a rename can land during the three
   * seconds the model takes to answer — and did, silently overwriting it.
   */
  const titleLockedRef = useRef(titleLocked)
  titleLockedRef.current = titleLocked
  /** Same reason: comparing against the title as it is when the answer lands. */
  const chatTitleRef = useRef(chatTitle)
  chatTitleRef.current = chatTitle

  useEffect(() => {
    if (streaming || titleLocked) return

    const real = chat.messages.filter((m) => !m.local && !m.error)
    const answered = real.some((m) => m.role === 'assistant' && m.content.trim())
    if (!answered) return

    const turns = real.filter((m) => m.role === 'user').length
    const titledAt = titledFor.current?.chat === chatId ? titledFor.current.turns : 0
    if (!shouldRetitle(turns, titledAt)) return

    // Mark first, with the turn count this request covers: the effect re-fires
    // on every message, and without this the same threshold would be asked
    // for twice while the first answer was still in flight.
    titledFor.current = { chat: chatId, turns }
    const forChat = chatId

    void window.wumpy.chat
      .title({ messages: real.map((m) => ({ role: m.role as string, content: m.content })) })
      .then((title) => {
        if (!title) return
        // Re-check on arrival: the user may have renamed, or moved to another
        // chat entirely, while this was in flight.
        if (titleLockedRef.current) return
        if (forChat !== chatId) return
        // An unchanged name is not worth a write or a sidebar repaint, and
        // most retitles on a steady topic come back identical.
        if (title === chatTitleRef.current) return

        setChatTitle(title)
        void window.wumpy.chats
          .save({ id: forChat, title, messages: chat.messages })
          .then(() => refreshChats())
      })
  }, [chat.messages, chatId, refreshChats, streaming, titleLocked])

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
          titleLocked
        })
        .then((summary) => {
          if (!summary) return
          if (!chatTitle) setChatTitle(summary.title)
          void refreshChats()
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [chat.messages, chatId, chatTitle, refreshChats, settings, streaming, titleLocked])

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
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickToBottom.current = near
    setAtBottom(near)
  }

  /**
   * Scrolls to the message before or after the one at the top of the view.
   *
   * Reading back through a long answer by paging is fine for prose, but the
   * thing you are usually looking for is a turn boundary.
   */
  const stepMessage = useCallback((delta: -1 | 1) => {
    const el = scroller.current
    if (!el) return
    const tops = Array.from(el.querySelectorAll<HTMLElement>('.msg')).map(
      (m) => m.offsetTop - el.offsetTop
    )
    if (tops.length === 0) return
    const here = el.scrollTop
    const next =
      delta === -1 ? [...tops].reverse().find((t) => t < here - 4) : tops.find((t) => t > here + 4)
    if (next === undefined) {
      el.scrollTop = delta === -1 ? 0 : el.scrollHeight
    } else {
      el.scrollTop = Math.max(0, next - 8)
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickToBottom.current = near
    setAtBottom(near)
  }, [])

  /** Back to the newest message, and start following it again. */
  const jumpToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = true
    setAtBottom(true)
    el.scrollTop = el.scrollHeight
  }, [])

  /**
   * Moves the transcript from the keyboard.
   *
   * The composer holds focus almost all the time, so PageUp and the rest went
   * nowhere: there was no way to read back through a long answer without
   * reaching for the mouse.
   */
  const scrollBy = useCallback((delta: number | 'top' | 'bottom') => {
    const el = scroller.current
    if (!el) return
    if (delta === 'top') el.scrollTop = 0
    else if (delta === 'bottom') el.scrollTop = el.scrollHeight
    else el.scrollTop += delta
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickToBottom.current = near
    setAtBottom(near)
  }, [])

  /* ------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        /**
         * From inside a proposal, Escape steps back out to the composer.
         *
         * Without this, stepping into a card with Ctrl+Down left the only
         * obvious way out closing the whole panel - and losing the proposal
         * along with it. Escape should undo the last thing you did, and the
         * last thing you did was move focus.
         */
        const insideCard = (e.target as HTMLElement | null)?.closest?.('.cmd, .ask')
        if (insideCard) {
          e.preventDefault()
          document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
          return
        }
        e.preventDefault()
        if (streaming) chat.stop()
        else if (picker) setPicker(null)
        else close()
        return
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Ctrl+Shift+M, not Ctrl+M: dictation had Ctrl+M first, and the
        // composer listens in the capture phase, so the binding I added here
        // never fired at all - pressing it started recording instead. Two
        // handlers on one chord, one of them silently dead.
        if (e.key.toLowerCase() === 'm') return
        if (e.key.toLowerCase() === 'n') {
          e.preventDefault()
          newChat()
          return
        }
        if (e.key.toLowerCase() === 'r') {
          e.preventDefault()
          void refreshChats()
          setPicker('resume')
          return
        }
        // Ctrl+D cycles the dock. Free since Quick/Developer mode went, and
        // moving the panel was otherwise a mouse click or a typed command -
        // the one piece of the window you could not drive from the keyboard.
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault()
          const order = DOCK_CYCLE
          const next = order[(order.indexOf(dock) + 1) % order.length]
          window.wumpy.panel.setDock(next)
          setSettings((prev) => (prev ? { ...prev, dock: next } : prev))
          return
        }
        // Ctrl+P pins and unpins. Pinning decides whether the panel survives
        // you clicking away, which is the thing most worth changing without
        // clicking away to do it.
        if (e.key.toLowerCase() === 'p') {
          e.preventDefault()
          togglePin()
          return
        }
        // Ctrl+K opens everything Wumpy can do, searchable.
        if (e.key.toLowerCase() === 'k') {
          e.preventDefault()
          setPicker((p) => (p === 'command' ? null : 'command'))
          return
        }
        // Ctrl+C stops, the way it does in a terminal - but only when there is
        // nothing selected, because with a selection it is still copy, and
        // taking that away to add a shortcut would be a poor trade.
        if (e.key.toLowerCase() === 'c') {
          if ((window.getSelection()?.toString() ?? '') !== '') return
          if (!streaming) return
          e.preventDefault()
          chat.stop()
          return
        }
        // Ctrl+Enter approves the command being asked about, so a proposal can
        // be dealt with without leaving the keyboard.
        if (e.key === 'Enter') {
          const pending = newestPending()
          if (!pending) return
          e.preventDefault()
          pending.run()
          return
        }
        /**
         * Ctrl+Down steps into the newest proposal; Esc comes back.
         *
         * Ctrl+Enter approves it outright, which is the quick path when the
         * card says what you expected. This is the other one: when you want
         * to read the command, open the contents, or pick a different button,
         * you have to be able to get there - and tabbing meant walking the
         * whole transcript first.
         *
         * Once inside, the arrow keys move between the card's own controls.
         */
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const cards = document.querySelectorAll<HTMLElement>('.cmd, .ask')
          const card = e.key === 'ArrowDown' ? cards[cards.length - 1] : cards[0]
          const first = card?.querySelector<HTMLElement>('button:not([disabled])')
          if (!first) return
          e.preventDefault()
          first.focus()
          card.scrollIntoView({ block: 'nearest' })
          return
        }
        // Ctrl+Home / Ctrl+End jump to the ends of the transcript.
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          scrollBy(e.key === 'Home' ? 'top' : 'bottom')
          return
        }
      }

      // Ctrl+Shift+Enter skips it instead.
      // Ctrl+Shift+M opens the model picker. Not Ctrl+M, which dictation
      // claimed first and takes in the capture phase.
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setPicker('model')
        return
      }

      // Ctrl+Shift+C copies the last answer. Selecting a streamed reply by
      // hand means dragging across a box that is still growing.
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
        const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.local)
        if (!last?.content.trim()) return
        e.preventDefault()
        void navigator.clipboard.writeText(last.content.trim())
        chat.note('Copied the last answer.')
        return
      }

      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'Enter') {
        const pending = newestPending()
        if (!pending) return
        e.preventDefault()
        pending.skip()
        return
      }

      // Alt+Up / Alt+Down step through the conversation a message at a time,
      // which is how you read back through a long answer without a mouse.
      if (e.altKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        stepMessage(e.key === 'ArrowUp' ? -1 : 1)
        return
      }

      // Shift+Tab cycles approval mode, as it does in Claude Code.
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void runCommand({ kind: 'approve', mode: 'cycle' }, '/approve')
        return
      }

      // Paging works wherever focus is, because it is almost always the box.
      if ((e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.altKey) {
        const el = scroller.current
        if (!el) return
        e.preventDefault()
        scrollBy((el.clientHeight - 40) * (e.key === 'PageUp' ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat, close, newChat, retitle, runCommand, scrollBy, stepMessage, picker, streaming])

  const warnedRef = useRef(false)
  useEffect(() => {
    if (autoAllowed) {
      warnedRef.current = false
      return
    }
    if (warnedRef.current) return
    warnedRef.current = true
    chat.note(
      `${AUTO_RUN_LIMIT} commands have run without you. Approving the next one by hand, ` +
        'or sending a message, starts the count again.'
    )
  }, [autoAllowed, chat])

  /* --------------------------------------------------------------- pickers */

  const DOCKS: Array<{ id: Dock; title: string; meta: string }> = [
    { id: 'left', title: 'Left edge', meta: 'Full height bar' },
    { id: 'right', title: 'Right edge', meta: 'Full height bar' },
    { id: 'top-left', title: 'Top left', meta: 'Compact card' },
    { id: 'top-right', title: 'Top right', meta: 'Compact card' },
    { id: 'bottom-left', title: 'Bottom left', meta: 'Compact card' },
    { id: 'bottom-right', title: 'Bottom right', meta: 'Compact card' }
  ]

  /**
   * Maps the open picker to its list. Every selection command routes through
   * here, so they all look and behave the same and nothing has to be
   * remembered by name.
   */
  function pickerProps(kind: NonNullable<typeof picker>): PickerProps {
    const close = (): void => setPicker(null)

    /**
     * Everything Wumpy can do, in one searchable list.
     *
     * Typing `/` already offered this, but only to someone who knew to try it.
     * A key that opens the list means nothing has to be known in advance -
     * which is the same reason every other choice goes through this component.
     */
    if (kind === 'command') {
      return {
        heading: 'Commands',
        placeholder: 'What do you want to do?',
        onClose: close,
        onPick: (name) => {
          close()
          // A key-only row is a reminder, not something to run. Picking one
          // does nothing rather than erroring, because the row is there to
          // be read.
          if (name.startsWith('key:')) return
          const spec = allCommands().find((c) => c.name === name)
          if (!spec) return
          // Run it and see. Several commands take an argument but do something
          // sensible without one - /tier opens the tier list, /pin toggles -
          // and those should just happen. Only one that actually complains
          // needs text, and that goes to the composer ready to be filled in.
          const action = spec.run('')
          if (action.kind === 'error') {
            setPrefill(`/${spec.name} `)
            return
          }
          void runCommand(action, `/${spec.name}`)
        },
        items: [
          ...allCommands().map((c) => ({
            id: c.name,
            title: `/${c.name}${c.arg ? ` <${c.arg}>` : ''}`,
            meta: c.hint,
            hint: SHORTCUT_FOR[c.name]
          })),
          // Most of the navigation has no slash command behind it, so until
          // now the only way to find Ctrl+Enter or Alt+Up was to be told.
          // They are listed here, filterable with everything else.
          ...KEY_ONLY.map((k) => ({
            id: `key:${k.keys}`,
            title: k.what,
            meta: 'keyboard',
            hint: k.keys
          }))
        ]
      }
    }

    if (kind === 'model') {
      const current = model

      /**
       * Every hosted model, whether or not a key exists for it.
       *
       * The list is how the user discovers the option is there, and picking
       * one without a key explains how to get a key - which is more use than
       * hiding it and leaving them to guess.
       */
      const cloudItems = CLOUD_MODELS.map((m) => {
        const ready = keyStatus?.configured.includes(m.provider) ?? false
        return {
          id: m.id,
          title: m.label,
          meta: `${PROVIDERS[m.provider].label}  ·  ${ready ? m.blurb : 'needs a key — /key ' + m.provider}`,
          active: m.id === current
        }
      })

      return {
        heading: 'Model',
        placeholder: 'Filter models…',
        emptyText: 'No models. Add a key with `/key`.',
        onClose: close,
        onPick: (name) => {
          const hosted = CLOUD_MODELS.find((m) => m.id === name)
          if (hosted && !(keyStatus?.configured.includes(hosted.provider) ?? false)) {
            // Not set, because setting it would leave the tier pointing at
            // something that cannot answer and the next question would fail
            // instead of explaining itself.
            chat.note(
              `**${hosted.label}** needs a ${PROVIDERS[hosted.provider].label} key first. ` +
                `Get one at ${PROVIDERS[hosted.provider].keyUrl} and paste it with ` +
                `\`/key ${hosted.provider} <key>\`, then pick it again.`
            )
            close()
            return
          }
          void patch({ model: name })
          void window.wumpy.assistant.status().then(setAssistant)
          chat.note(
            hosted
              ? `Now answering with **${hosted.label}**. ${hosted.blurb}`
              : `Now answering with \`${name}\`.`
          )
          close()
        },
        items: cloudItems
      }
    }

    if (kind === 'engine') {
      return {
        heading: 'Search engine',
        placeholder: 'Filter…',
        onClose: close,
        onPick: (id) => {
          void patch({ searchEngine: id })
          chat.note(`Searches will open in **${SEARCH_ENGINES[id as 'duckduckgo'].label}**.`)
          close()
        },
        items: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({
          id,
          title: e.label,
          meta: new URL(e.url).hostname,
          active: id === (settings?.searchEngine ?? 'duckduckgo')
        }))
      }
    }

    if (kind === 'dock') {
      return {
        heading: 'Position',
        placeholder: 'Filter positions…',
        onClose: close,
        onPick: (id) => {
          window.wumpy.panel.setDock(id as Dock)
          setSettings((prev) => (prev ? { ...prev, dock: id as Dock } : prev))
          close()
        },
        items: DOCKS.map((d) => ({ ...d, active: d.id === dock }))
      }
    }

    // resume / delete
    const removing = kind === 'delete'
    return {
      heading: removing ? 'Delete a chat' : 'Resume',
      placeholder: removing ? 'Filter chats to delete…' : 'Filter chats…',
      emptyText: 'Nothing saved yet. Chats save themselves as you go.',
      removeMode: removing,
      onClose: close,
      onPick: (id) => void openChat(id),
      onRemove: (id) => {
        void window.wumpy.chats.delete(id).then(() => {
          // Deleting the chat that is open only removed the file: the next
          // autosave wrote it straight back under the same id, so it vanished
          // from the list and quietly returned on the following message.
          if (id === chatId) newChat()
          void refreshChats()
        })
      },
      items: savedChats.map((c) => ({
        id: c.id,
        title: c.title,
        meta: `${c.messageCount} msg  ·  ${when(c.updatedAt)}`,
        active: c.id === chatId
      }))
    }
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
  const compact = !isTall(dock)

  return (
    <div
      className={`panel dock-${dock} ${compact ? 'is-compact' : 'is-tall'} ${
        visible ? 'panel-in' : ''
      }`}
      data-theme="dark"
    >
      <Header
        status={assistant}
        dock={dock}
        onCycleDock={(d) => {
          window.wumpy.panel.setDock(d)
          setSettings((prev) => (prev ? { ...prev, dock: d } : prev))
        }}
        pinned={pinned}
        onTogglePin={togglePin}
        onNewChat={newChat}
        onRename={() => setPrefill(`/rename ${chatTitle ?? ''}`)}
        onShowChats={() => {
          void refreshChats()
          setPicker((p) => (p ? null : 'resume'))
        }}
        onClose={close}
        hotkeyLabel={hotkeyLabel}
        title={chatTitle}
      />

      {picker ? (
        <Picker {...pickerProps(picker)} />
      ) : (
        <div className="scroll" ref={scroller} onScroll={onScroll}>
          {messages.length === 0 ? (
            <Empty
              hotkeyLabel={hotkeyLabel}
              online={assistant?.ready ?? false}
              model={model}
              compact={compact}
            />
          ) : (
            messages.map((m) => {
              // Produced in this session, rather than loaded from disk.
              const fresh = generated.current.has(m.id)
              return (
                <Message
                  key={m.id}
                  message={m}
                  streaming={m.id === streamingId}
                  showReasoning={settings?.showReasoning ?? false}
                  smoothText={settings?.smoothText ?? false}
                  canAutoRun={fresh ? claimAutoRun : undefined}
                  onGrow={pinToBottom}
                  onRunCommand={canRunCommands ? runShellCommand : undefined}
                  onCommandResult={onCommandResult}
                  onAnswer={onAnswerQuestion}
                  onSearch={canSearch ? runSearch : undefined}
                  onSearchResults={onSearchResults}
                  onWriteFile={canRunCommands ? writeFile : undefined}
                  onCheckWrite={checkWrite}
                  onWritten={onWritten}
                  /**
                   * An automatic mode only applies to what was just said.
                   *
                   * Reopening a saved chat re-mounts every card in it, and
                   * those are finished messages whose actions already
                   * happened. The command card has been told this since it was
                   * written - "without this an automatic mode would run the
                   * whole transcript again on load" - and the other three were
                   * not, so a reopened chat on accept-all re-opened every link,
                   * rewrote every file and re-ran every search. Reported as
                   * "every time I reopen a chat it reruns the scripts".
                   *
                   * A reopened card is not disabled, only demoted to asking:
                   * the buttons come back and a deliberate click still works.
                   */
                  autoWrite={fresh && (settings?.approvalMode ?? 'manual') === 'all'}
                  onOpenLink={canOpenLinks ? openLink : undefined}
                  onOpenSearch={openSearch}
                  onOpened={onOpened}
                  linkMode={fresh ? linkMode : 'manual'}
                  searchEngine={settings?.searchEngine ?? 'duckduckgo'}
                  looseFences={looseFences}
                />
              )
            })
          )}

          {/* Marks the end of a finished reply, so a long answer has a visible
              bottom edge rather than just stopping.

              Not only after an assistant message: a command that succeeds
              silently now ends the turn with a note instead of a reply, and
              that left the transcript simply stopping, with no line and no
              runtime. Anything but a user message is the end of a turn. */}
          {!streaming && messages.length > 0 && messages[messages.length - 1].role !== 'user' && (
            <div className="turn-end" aria-hidden="true">
              <span>{endOfReplyLabel(stats)}</span>
            </div>
          )}
        </div>
      )}

      {/* Scrolling up stops the view following the answer, and there was no way
          back but to scroll all the way down by hand. */}
      {!picker && !atBottom && messages.length > 0 && (
        <button
          type="button"
          className="jump-bottom"
          onClick={jumpToBottom}
          title="Latest (Ctrl+End)"
        >
          <span className="caret-glyph is-open" aria-hidden="true">
            &#9656;
          </span>
          Latest
        </button>
      )}

      <StatusBar
        model={model}
        ready={assistant?.ready ?? false}
        streaming={streaming}
        stats={stats}
        usage={usage}
        compact={compact}
        approvalMode={settings?.approvalMode ?? 'manual'}
        onCycleApproval={() => void runCommand({ kind: 'approve', mode: 'cycle' }, '/approve')}
        onCompact={() => void compactHistory()}
      />

      <Composer
        onSend={onSend}
        onStop={chat.stop}
        streaming={streaming}
        focusToken={focusToken}
        prefill={prefill}
        queued={queued}
        onUnqueue={() => {
          setPrefill(queued ?? '')
          setQueued(null)
        }}
        placeholder="Ask Wumpy…"
      />
    </div>
  )
}

function Empty({
  hotkeyLabel,
  online,
  model,
  compact
}: {
  hotkeyLabel: string
  online: boolean
  model: string
  compact: boolean
}): React.JSX.Element {
  return (
    <div className="empty">
      <img className="empty-mark" src={logo} alt="" width={48} height={48} />
      {!compact && <h1>Wumpy</h1>}
      {!online ? (
        <p>
          No key yet for <code>{model}</code>. Add one with <code>/key</code> — Codestral is free
          and needs no card.
        </p>
      ) : (
        <p>
          <code>{model}</code>. Press <kbd>{hotkeyLabel}</kbd> anywhere to summon this,{' '}
          <kbd>Ctrl+K</kbd> for everything it can do.
        </p>
      )}
    </div>
  )
}

/** What each approval mode means, said plainly when it changes. */
const APPROVAL_NOTE: Record<ApprovalMode, string> = {
  manual: '**Manual** — every command waits for you.',
  auto: '**Auto** — commands that only read run themselves; anything that changes something still asks.',
  all: '**Accept all** — commands run without asking. Destructive ones still raise a system dialog.'
}

/** Relative time for picker rows. */
function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Summary under a finished answer: how long it took and how fast it ran. */
function endOfReplyLabel(stats: ChatStats): string {
  const parts: string[] = []
  if (stats.lastTurnMs !== null) {
    const ms = stats.lastTurnMs
    if (ms < 60_000) parts.push(`${(ms / 1000).toFixed(1)}s`)
    else {
      const total = Math.round(ms / 1000)
      parts.push(`${Math.floor(total / 60)}m ${total % 60}s`)
    }
  }
  if (stats.speed !== null) parts.push(`${stats.speed.toFixed(1)} tok/s`)
  if (stats.lastCompletionTokens !== null) parts.push(`${stats.lastCompletionTokens} tok`)
  return parts.length ? parts.join(' · ') : 'end of reply'
}

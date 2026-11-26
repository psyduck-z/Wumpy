import { deadline } from './deadline'
import { DEADLINE_CLEARED_TEXT, deadlineDueText, deadlineIn, deadlineSetText } from '@shared/deadline'
import { useVoiceTurn } from './hooks/useVoiceTurn'
import { useReflect } from './hooks/useReflect'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ChatSummary,
  ContextUsage,
  Dock,
  HotkeyState,
  AssistantStatus,
  UpdateState,
  ApprovalMode,
  ShellKind,
  ShellResult,
  LinkResult,
  WriteResult,
  SearchResult,
  KeyStatus,
  WumpySettings,
  Attachment,
  DesktopResult
} from '@shared/types'
import { isTall } from '@shared/types'
import type { PoolView } from '@shared/pool'
import {
  DEFAULT_ENGINE,
  isSearchEngine,
  looksLikeUrl,
  SEARCH_ENGINES,
  type LinkApproval
} from '@shared/links'
import { clippedOutput, commandFeedback } from '@shared/parsefail'
import {
  desktopLine,
  openedLine,
  ranLine,
  screenLine,
  searchedLine,
  wroteLine
} from '@shared/notify'
import { CONTEXT_TOKENS, DEFAULT_MODEL, preambleTokens } from '@shared/assistant'
import {
  COMPACT_COOLDOWN_MS,
  estimateWithFiles,
  KEEP_PICTURES,
  needsRoom,
  roomNote,
  tooBig
} from '@shared/pressure'
import { refusedAttachment, sendsBytes, withoutBytes } from '@shared/attach'
import { needsFor } from '@shared/needs'
import { shouldRetitle } from '@shared/titles'
import {
  CLOUD_MODELS,
  PROVIDERS,
  eyeReady,
  freshNote,
  modelTag,
  providerFor,
  seesMedia,
  type CloudModel
} from '@shared/cloud'
import {
  DEFAULT_ORDERING,
  ORDERINGS,
  alive,
  isOrdering,
  orderNote,
  rankedModels,
  readOrdering,
  type Ordering
} from '@shared/order'
import {
  matchSpoken,
  modelShortlist,
  numberedSpeech,
  orderingIn,
  sayModel,
  shortlistSpeech,
  spokenAnd,
  type ShortEntry,
  type ShortWhy
} from '@shared/spokenpick'
import { afterTurn, handsFree, tell } from './handsfree'
import { skillSaidAs, skillsAloud, speakable } from '@shared/spoken'
import { useChat, nextId, type ChatStats } from './hooks/useChat'
import { useListening } from './hooks/useListening'
import { useLiveNotes } from './hooks/useLiveNotes'
import { skillPrompt, shortly } from '@shared/skills'
import type { AudioSource } from './loopback'
import {
  ENOUGH_WORDS,
  elapsed,
  meetingTurn,
  stamp,
  wantsNotes,
  wordCount,
  type Listening
} from '@shared/meeting'
import {
  allCommands,
  setSkillCommands,
  parseCommand,
  helpText,
  shortcutsText,
  KEY_ONLY,
  SHORTCUT_FOR,
  type CommandAction
} from './commands'
import {
  entryIndex,
  focusablesIn,
  regionAfter,
  regionOf,
  REGION_SELECTOR,
  type Region
} from './keyboard'
import { newestPending, onPendingChange, pendingIn, runningCount } from './pending'
import { useAgentState } from './agentstate'
import { turnEnd } from '@shared/turnend'
import { forgetClaims } from './once'
import { forgetAllLive } from './live'
import { poolLines } from './quota'
import { footprintLines } from '@shared/footprint'
import { settingsLines } from './settingsreport'
import { rankLines, rankSummary } from '@shared/ranking'
import { journalLines, journalSpeech, type JournalView } from '@shared/journal'
import { DEFAULT_RUNS, freshLatencies, probeLines } from '@shared/probe'
import { copyText } from './copy'
import { Toast } from './components/Toast'
import { forgetActions, record } from './ledger'
import { matchIntent } from './intents'
import { AUTO_RUN_LIMIT, autoRunEligible } from './autorun'
import {
  circlingNote,
  screenPrint,
  shortStep,
  stuck,
  trailLines,
  type Visit
} from '@shared/circling'
import { DOCK_CYCLE, Header } from './components/Header'
import { APP_WINDOW } from './appwindow'
import { clampRounds } from '@shared/reflect'
import { useAgents } from './hooks/useAgents'
import { PAGE_ROUNDS, pageErrorText } from '@shared/pagecheck'
import { LANG_NAME, codeErrorText } from '@shared/codecheck'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { VoiceTurnBar } from './components/VoiceTurnBar'
import { FINISHED, voiceView } from './voiceview'
import { StatusBar } from './components/StatusBar'
import logo from './assets/logo.png'
import { Picker, type PickerProps } from './components/Picker'
import { firstShown, foldsTranscript, hiddenCount, REVEAL_STEP } from './transcript'
import { activityFor } from '@shared/activity'
import { voiceprintNote } from './voiceprintnote'
import { VoiceCalibration } from './components/VoiceCalibration'

/**
 * Mirrors the main process's accelerator formatting for display: the key is
 * Win on Windows and Super on Omarchy, which is what Hyprland and its own
 * keybinding list call it.
 */
function prettify(accelerator: string): string {
  const logo = window.wumpy.platform === 'win32' ? 'Win' : 'Super'
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, logo).replace(/\+/g, ' + ')
}

const NEWLINE = String.fromCharCode(10)

/**
 * What to say when there is a transcript but not enough of it.
 *
 * Better than a paragraph of invention: a model handed ten seconds of
 * speech and asked for the key decisions will produce key decisions.
 */
function tooLittle(heard: Listening | null): string {
  const words = heard ? wordCount(heard) : 0
  return words
    ? `Only ${words} words so far — too little to write anything from.`
    : 'Nothing heard yet.'
}

/**
 * What the first model of each kind on the spoken list also answers to:
 * "the fastest", "the best one", "the smartest".
 */
const SPOKEN_ALIASES: Record<ShortWhy, string[]> = {
  balanced: ['best', 'recommended', 'balanced', 'top'],
  smartest: ['smartest', 'cleverest', 'smart', 'clever'],
  fastest: ['fastest', 'quickest', 'fast', 'quick']
}

/** How many saved chats are read out at first; the rest follow a pause. */
const SPOKEN_CHATS = 12

export default function App(): React.JSX.Element {
  const chat = useChat()
  const { messages, streaming, streamingId, stats } = chat

  /**
   * A meeting being transcribed, if one is. See @shared/meeting.
   *
   * Here rather than in the composer, where dictation lives, because this
   * one outlives everything around it: the session survives the panel being
   * hidden, a new chat being started and the composer being re-rendered,
   * and the only thing with that lifetime is App.
   */
  const listening = useListening(useCallback(() => allCommands().map((c) => c.name), []))
  /** The live notes card that follows a meeting while it is heard. */
  const liveNotes = useLiveNotes(listening, chat)

  /* Their skills, as commands: read at start, and again each time the panel
     comes up, so a SKILL.md edited by hand is a command without a restart. */
  useEffect(() => {
    const refresh = (): void => {
      void window.wumpy.skills.list().then(setSkillCommands).catch(() => undefined)
    }
    refresh()
    const offShown = window.wumpy.panel.onShown(refresh)
    /* Skills that arrived from another device. */
    const offChanged = window.wumpy.skills.onChanged(refresh)
    return () => {
      offShown()
      offChanged()
    }
  }, [])

  /**
   * What the model is doing, read off the reply as it arrives.
   *
   * Derived rather than stored: the text is already in `messages` and a
   * second copy in state would be one render behind the thing it describes.
   * Only while streaming - once the turn lands the cards say everything this
   * line was standing in for.
   */
  /** Set while a compaction is running, so the user is not left guessing. */
  const [compacting, setCompacting] = useState(false)

  /**
   * True while the panel is hidden in the tray.
   *
   * Electron marks a hidden window as hidden to the page, so this is the
   * same signal the open animation already uses - and it is the real
   * "nobody is here", as opposed to twenty seconds without a keystroke
   * while someone reads the answer on screen.
   */
  const [tucked, setTucked] = useState(false)

  /**
   * The key pool behind the current model, for the meter in the status bar.
   *
   * Asked for as "make it easier to navigate the quota": the figures existed
   * but only `/usage` showed them, so the first sign of a spent pool was a
   * turn that refused. Refreshed when a turn ends and when the panel is
   * summoned - never on a timer, because it is free to ask main and there is
   * nothing to watch while nothing is happening.
   */
  const [pool, setPool] = useState<PoolView | null>(null)

  const activity = useMemo(() => {
    /*
     * Compaction outranks the reply, because it is the thing that looks
     * like a hang: the panel sits there, nothing streams, and a request to
     * another model is quietly running. Asked for by name - "add a progress
     * bar when compacting and so far so i know that its compacting".
     */
    if (compacting) {
      return {
        kind: 'compact' as const,
        label: 'Compacting earlier turns',
        detail: 'making room in the context',
        count: 1,
        open: true
      }
    }
    if (!streaming || !streamingId) return null
    const live = messages.find((m) => m.id === streamingId)
    return live ? activityFor(live.content, live.thinking ?? '') : null
  }, [compacting, streaming, streamingId, messages])

  const [settings, setSettings] = useState<WumpySettings | null>(null)
  const [assistant, setAssistant] = useState<AssistantStatus | null>(null)
  /** Wumpy's own update, for the header's pill (main/updater.ts). */
  const [update, setUpdate] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.wumpy.update.state().then(setUpdate)
    return window.wumpy.update.onState(setUpdate)
  }, [])
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
  const [focusToken, setFocusToken] = useState(0)

  /**
   * A line that appears for a moment and leaves nothing behind.
   *
   * For the answers that are not part of the conversation. Writing "no saved
   * chats" into the transcript would put a sentence the model never said in
   * a chat that then saves itself with it.
   */
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const say = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  /**
   * A message typed while a turn was running.
   *
   * It used to be dropped: Enter did nothing, the text stayed in the box, and
   * nothing said why. One is held at a time - a second replaces it, because
   * what you meant to say next is the last thing you typed.
   */
  /**
   * Messages typed while an answer was running, oldest first.
   *
   * A list rather than one slot: typing a second thing used to overwrite the
   * first, so of two queued lines only the last was ever sent and the other
   * vanished without a trace.
   */
  const [queued, setQueued] = useState<string[]>([])
  /** Text the command menu has dropped into the composer, with a bump token. */
  const [prefill, setPrefillState] = useState({ text: '', token: 0 })
  const setPrefill = useCallback((text: string) => {
    setPrefillState((p) => ({ text, token: p.token + 1 }))
  }, [])

  // Saved chats
  /** Which picker is open, if any. One list UI serves them all. */
  /** Reading sentences for the voiceprint: see components/VoiceCalibration. */
  const [calibrating, setCalibrating] = useState(false)
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

  /* A status change can be Ollama starting or stopping, which only the key
     status carries - so both are read again. */
  useEffect(
    () =>
      window.wumpy.assistant.onStatus((s) => {
        setAssistant(s)
        void window.wumpy.keys.status().then(setKeyStatus)
      }),
    []
  )

  // The tray menu can change approval mode and the rest from outside the panel.
  useEffect(() => window.wumpy.settings.onChange(setSettings), [])
  useEffect(
    () =>
      window.wumpy.panel.onDock((d) => setSettings((prev) => (prev ? { ...prev, dock: d } : prev))),
    []
  )

  /**
   * The caret, on every summon.
   *
   * There was a `visible` state here driving a slide-in, and the animation it
   * drove was deleted - the CSS says "no entrance animation: the panel is
   * simply there when summoned" and sets opacity to 1. What was left was a
   * class, `panel-in`, with no rule anywhere in the repo, and a state change
   * that re-rendered the whole panel twice per summon: once on hide and once
   * in the same tick the window becomes visible, which is the worst possible
   * moment to be laying out two thousand lines of component for no reason.
   *
   * Only the focus token is left, which does something.
   */
  useEffect(() => {
    const off = window.wumpy.panel.onShown(() => {
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
      window.removeEventListener('focus', onWindowFocus)
      off()
    }
  }, [])

  /**
   * Whether the panel is in the tray, asked of the main process.
   *
   * document.hidden was the obvious answer and it is wrong here. The window
   * turns off backgroundThrottling on purpose - the focus retry and the open
   * animation both have to keep running while it is hidden - and Chromium
   * then reports the page as 'visible' for as long as it exists. Measured
   * over the DevTools protocol on a window that had never once been shown:
   * visibilityState 'visible', hasFocus false.
   *
   * So everything that waits for "nobody is looking" was waiting on a flag
   * that never flipped: idle compaction, asked for by name - "the compaction
   * while idle should happen while it's hidden inside the tray" - could not
   * fire at all. Main knows, and now says.
   *
   * The visibilitychange listener stays: it costs nothing and would be the
   * right signal if Electron ever did mark the page hidden.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) setTucked(true)
    }
    const offShown = window.wumpy.panel.onShown(() => setTucked(false))
    const offTucked = window.wumpy.panel.onTucked(() => setTucked(true))
    void window.wumpy.panel.visible().then((on) => setTucked(!on))
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      offShown()
      offTucked()
      document.removeEventListener('visibilitychange', onVisibility)
    }
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
    chat.setContext({ chatTitle, chatId })
  }, [chat, chatTitle, chatId])

  /**
   * Close, immediately.
   *
   * This waited 140ms to "let the slide-out play", and there has been no
   * slide-out to play since the animation was removed - so clicking close
   * left the panel sitting on screen for a seventh of a second doing
   * nothing, which is long enough to see.
   */
  const close = useCallback(() => {
    window.wumpy.panel.hide()
  }, [])

  /** Returns the list as well as storing it: the caller needs it this turn. */
  const refreshChats = useCallback(async () => {
    const list = await window.wumpy.chats.list()
    setSavedChats(list)
    return list
  }, [])

  /**
   * How much of a long transcript is in the page. Declared up here because
   * both switching chats and opening one have to put it back to the start.
   */
  const [revealed, setRevealed] = useState(0)

  const newChat = useCallback(() => {
    chat.clear()
    setRevealed(0)
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
    /* A transcript belongs to the conversation it was gathered for. Left
       behind, it would ride along on every turn of an unrelated chat -
       which is exactly the invisible cost the ambient attachment is
       bounded to avoid. Stops the session too, if one is still running:
       nothing would be listening to, and nobody would know it was. */
    void listening.forget()
    liveNotes.reset()
  }, [chat, listening, liveNotes])

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
      setRevealed(0)
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
      /*
       * And land at the end of it. "when you resume a chat, yeah, you should
       * auto go there" - opening one used to leave the view wherever the
       * previous chat had been scrolled to, which on a long conversation is
       * the middle of someone else's sentence. After the layout effect has
       * run on the new messages, so scrollHeight is the new chat's.
       */
      stickToBottom.current = true
      setAtBottom(true)
      requestAnimationFrame(() => {
        const el = scroller.current
        if (el) el.scrollTop = el.scrollHeight
      })
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

  /**
   * The `/log` on screen that is keeping up, if there is one.
   *
   * Asked for: "when my logs is displayed, also make it auto update... when
   * it rechecks the models, also automatically add that in, especially
   * while I'm still looking at the logs". The report was a snapshot, and
   * what it reports on happens with nobody typing - a sweep finishing is
   * the one line somebody sitting looking at the panel would most like to
   * watch arrive.
   *
   * The newest one only, and only while it is the last thing in the chat.
   * A block that has scrolled above an answer is part of what was said at
   * the time, and rewriting it would be editing the conversation behind the
   * reader; once something else is said, it stands as it was.
   */
  const liveLog = useRef<{ id: string; view: JournalView } | null>(null)

  useEffect(
    () =>
      window.wumpy.journal.onChange(() => {
        const live = liveLog.current
        if (!live) return
        const shown = chatRef.current.messages
        /* No longer the last thing said, or gone with the chat it was in:
           it stops keeping up rather than being rewritten where it sits. */
        if (shown[shown.length - 1]?.id !== live.id) {
          liveLog.current = null
          return
        }
        /* Fetched only now, which is why the message from main carries no
           payload: a machine nobody is watching sends a few bytes an hour
           and copies nothing across the bridge. */
        void window.wumpy.journal.get().then((entries) => {
          if (liveLog.current?.id !== live.id) return
          chatRef.current.update(live.id, journalLines(entries, live.view).join(NEWLINE))
        })
      }),
    []
  )
  const retitleRef = useRef(retitle)
  retitleRef.current = retitle

  /*
   * Answers to Wumpy's own questions act through these: the answer handler
   * below is a stable callback, declared long before runCommand and
   * openChat exist in this render.
   */
  const runCommandRef = useRef<(action: CommandAction, raw: string) => Promise<void>>(async () => {})
  const openChatRef = useRef<(id: string) => Promise<void>>(async () => {})
  /** What a yes does, for each delete-or-keep question still on screen. */
  const confirms = useRef(new Map<string, () => void>())
  openChatRef.current = openChat

  /**
   * Making room before a result is handed back, for callbacks defined above
   * the compaction they need.
   *
   * A ref rather than the function itself: every automatic hand-back below is
   * a stable callback with an empty dependency list, and compactHistory is
   * declared two hundred lines further down. Naming it in a dependency array
   * up here would read a `const` during the render that initialises it, which
   * is a crash rather than a warning.
   *
   * Returns true when it summarised something, so the caller can say so.
   */
  const makeRoomRef = useRef<(() => Promise<boolean>) | null>(null)
  /** When the last automatic summary ran, for the cooldown below. */
  const lastCompact = useRef(0)
  const makeRoom = useCallback(async (): Promise<boolean> => {
    const room = makeRoomRef.current
    return room ? room() : false
  }, [])

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
    if (asked) {
      /* The rest carry what each option stands for - a model id, a chat id -
         because the label on the button is not the thing itself. */
      const index = asked.options.indexOf(option)
      const value = asked.values?.[index] ?? option
      switch (asked.kind) {
        case 'model':
          void runCommandRef.current({ kind: 'model', name: value }, `/model ${value}`)
          return
        case 'resume':
          void openChatRef.current(value).then(() => tell(`Opened ${option}.`))
          return
        case 'deletechat':
          void runCommandRef.current(
            { kind: 'delete', pick: false, confirm: true, chatId: value },
            '/delete'
          )
          return
        case 'confirm': {
          const then = confirms.current.get(messageId)
          confirms.current.delete(messageId)
          if (index !== 0) {
            tell('Okay, left it.')
            return
          }
          /* Asked in an earlier session: the yes it was waiting for has no
             action any more, and guessing one would be worse than asking. */
          if (then) then()
          else live.note('That question is from before Wumpy restarted. Ask again.')
          return
        }
      }
    }
    live.send(option)
  }, [])

  const canSearch = settings?.searchEnabled ?? true

  const runSearch = useCallback((query: string) => window.wumpy.search.run(query), [])

  /** Hands search results back so the model can answer from them. */
  const onSearchResults = useCallback(
    async (query: string, results: SearchResult[], provider: string, error?: string) => {
      if (!error) record('search', query)
      await makeRoom()
      const body = error
        ? `The search failed: ${error}`
        : results
            .map((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, `   ${r.snippet}`].join('\n'))
            .join('\n')
      chatRef.current.notify(searchedLine(query))
      /* Sent and not shown, for the same reason as a command's output: the
         user did not type "Searched: pacific midnight", Wumpy did. */
      chatRef.current.send(
        [
          `Results for "${query}" (via ${provider}):`,
          '',
          body,
          '',
          'Answer the original question from these. Cite the sources you used.'
        ].join('\n'),
        `Searched: ${query}`,
        undefined,
        true
      )
    },
    [makeRoom]
  )

  /* ----------------------------------------------------------- the screen */

  const canSeeScreen = settings?.screenEnabled ?? true

  const captureScreen = useCallback(() => window.wumpy.screen.capture(), [])

  /** Opens a picture the model named, once the card has been pressed. */
  const lookAtPath = useCallback(
    (path: string) => window.wumpy.look.file(path),
    []
  )

  /**
   * Hands a picture off the disk to the model, as the user's own next turn.
   *
   * The same hand-back the screenshot uses and for the same reason: it is
   * where attachments already render, so what the model was given is what
   * is on screen in front of the user.
   *
   * Says the file's NAME in the text as well as attaching it. A model that
   * asked for build.png and is handed an unnamed image has to assume it is
   * the right one; told the name, it can notice when it is not - which is
   * the whole failure mode of a path the model guessed at.
   */
  const onLooked = useCallback(
    async (file: Attachment, why: string) => {
      await makeRoom()
      chatRef.current.notify(`Opened ${file.name ?? 'a picture'}`)
      chatRef.current.send(
        [
          `Wumpy opened ${file.name ?? 'the file'} and attached it. This was not sent by`,
          'the user and they have not said anything - do not thank them for it or',
          'answer as though they spoke.',
          ...(why ? [`You asked for it in order to: ${why}`] : []),
          'Answer from what is actually in the picture. If it is too small or cut off',
          'to read, say so rather than guessing at it.'
        ].join(String.fromCharCode(10)),
        `Opened ${file.name ?? 'a picture'}`,
        [file]
      )
    },
    [makeRoom]
  )

  /**
   * Hands the photograph to the model as the user's own next turn.
   *
   * Attached to a user message rather than slipped in as a result, because
   * that is where attachments already render - so the picture the model was
   * given is the picture on the screen in front of them, with no separate
   * path to trust.
   */
  const onScreenCaptured = useCallback(async (shot: Attachment) => {
    /* A photograph is the single most expensive thing in this conversation -
       roughly 1,100 tokens of it - so this is the hand-back most worth
       making room for first. */
    await makeRoom()
    chatRef.current.notify(screenLine())
    /*
     * A look that sent no picture says so, and says it to the model.
     *
     * The old wording was unconditional - "a screenshot is attached, answer
     * from what is actually visible" - and on a model without vision the
     * bytes never left the machine, so that paragraph was the app telling
     * the model it had been given something it had not. What it does have is
     * the control list, which is text and reaches every model, and which is
     * what the acting steps work from anyway.
     */
    const picture = shot.picture !== false
    const nothing = !picture && !(shot.elements ?? []).length
    /*
     * A look joins the trail too.
     *
     * The loop that made this necessary alternated acting and looking, and
     * the looks are the half that reaches a model with no memory of them:
     * KEEP_PICTURES is 2, so the third look at the passage is the first one
     * the model cannot compare with anything. Counted here, so "the same
     * screen as step 4" can be said at all - and so a run of nothing but
     * looks reaches the same ceiling a run of steps does.
     *
     * The picture is still attached when the trail says to stop. Dropping it
     * would save 1,100 tokens and make the paragraph above it untrue, which
     * is the trade this file has already got wrong once.
     */
    trailRef.current.push({
      step: 'looked at the screen',
      screen: screenPrint(shot.elements, shot.bytes),
      controls: shot.elements?.length ?? 0
    })
    const trail = trailLines(trailRef.current)
    const circling = circlingNote(trailRef.current)
    const halted = stuck(trailRef.current)
    chatRef.current.send(
      [
        ...(picture
          ? [
              'A screenshot was taken automatically and is attached. This was not sent',
              'by the user and they have not said anything - do not thank them for it',
              'or answer as though they spoke.',
              'Answer from what is actually visible. If something is too small or cut',
              'off to read, say so rather than guessing.'
            ]
          : [
              'Wumpy looked at the screen automatically. This was not sent by the user',
              'and they have not said anything - do not thank them for it or answer as',
              'though they spoke.',
              'NO PICTURE was sent to you, because the model you are cannot read one.',
              'What is on screen is listed below by name instead, and that is what you',
              'act on: press, focus, fill, read and reveal find a control by name',
              'wherever it is.',
              /*
               * Borrowed eyes, labelled as borrowed.
               *
               * The line above used to end "say you cannot see it rather than
               * describing a screen you were not shown", which stays true of
               * everything the description does not cover - so the warning is
               * repeated here rather than dropped. What changes is that there
               * is now something to answer from, and the model must not
               * mistake it for its own sight: it did not see this screen, it
               * is being told about it by another model that did.
               */
              ...(shot.described
                ? [
                    '',
                    `A vision model (${shot.describedBy ?? 'another model'}) looked at the`,
                    'screenshot for you and reported this. It is SECOND-HAND - you did not',
                    'see the screen - so answer from it, say so when the question needs',
                    'detail it does not cover, and never claim to have seen anything it',
                    'does not mention:',
                    shot.described,
                    '[End of what it saw.]'
                  ]
                : [
                    'If what was asked is how something LOOKS - a colour, an image, the',
                    'wording of something that is not a named control - say you cannot see',
                    'it rather than describing a screen you were not shown.'
                  ])
            ]),
        ...(nothing
          ? [
              'Nothing could be read: desktop control is off, so there is no control',
              'list either. Say so and ask them to turn it on in settings.'
            ]
          : namedControls(shot)),
        ...(trail.length ? ['', ...trail] : []),
        circling ? `${NEWLINE}${circling}` : '',
        halted ? `${NEWLINE}STOP: ${halted}` : ''
      ]
        .filter(Boolean)
        .join(String.fromCharCode(10)),
      picture ? 'Shared my screen' : 'Looked at my screen',
      /* Nothing is attached when there is no picture: an empty data URL
         through the wire is an attachment that renders as a broken image. */
      picture ? [shot] : [],
      true
    )
  }, [makeRoom])

/**
 * The names of what is on screen, for the model to press instead of guess.
 *
 * Reported: "it keeps on missing the TO fillin box, and keeps clicking the
 * same place every time." Estimating a coordinate from a scaled screenshot
 * is wrong the same way every time the same picture is looked at, so the
 * loop cannot break itself. A list of names breaks it.
 */
function namedControls(shot: Attachment): string[] {
  const list = shot.elements ?? []
  if (list.length === 0) return []
  /*
   * And WHICH window they are in, because once they were the wrong ones.
   *
   * The list is read from the window that has the foreground, and when the
   * user has just typed into Wumpy that window is Wumpy. A log of a real
   * attempt shows sixty "controls on screen" that were Wumpy's own
   * transcript, and then `PRESS FAILED` on an element named
   * `Press "Inbox - zechariah"` - the text of Wumpy's own card. Saying the
   * window turns that into something the model can see in one line.
   */
  const where = shot.window ? ` in "${shot.window}"` : ''
  /*
   * And how many there are altogether.
   *
   * The list is capped at sixty and Gmail reports 673 named controls, so
   * "these 60 controls are on screen" invited the conclusion that a button
   * it could not see did not exist - which is exactly when a model starts
   * guessing pixels. Every by-name step searches the whole tree, so a name
   * that is missing from the list can still be used, and that is worth one
   * sentence.
   */
  const more =
    (shot.elementTotal ?? 0) > list.length
      ? [
          `That is the ${list.length} most useful of ${shot.elementTotal} named controls in that`,
          'window. press, focus, fill, read and reveal search ALL of them, so a name you',
          'expect but cannot see in this list is still worth trying.'
        ]
      : []
  return [
    '',
    `These ${list.length} controls are on screen right now${where}, with their`,
    /* Not "a pixel from the picture": the same list is handed over when there
       was no picture, and on that turn the phrase describes nothing. */
    'real centres. PRESS one by name rather than guessing a pixel:',
    ...list.map((e) => `  ${e.role}: ${JSON.stringify(e.name)}`),
    ...more
  ]
}

  /* ---------------------------------------------------- acting on the screen */

  /** Only with browser control on; the main process enforces that too. */
  const canDrive = settings?.browserEnabled ?? false

  /**
   * Where this run of automatic steps has already been.
   *
   * In a ref for the reason the unattended-run budget is: a card decides
   * whether to act in an effect the moment it appears, and state lands a
   * render later. Reset when the user types - see onSend - which makes
   * typing both the rule and the way out of it.
   */
  const trailRef = useRef<Visit[]>([])

  /**
   * Runs a plan, unless the trail says the plan is going in circles.
   *
   * Refused here rather than in main, because the thing being judged is the
   * SEQUENCE and only this side has it: main sees one plan at a time and
   * answers it correctly every time. Reported as a refusal and not as a
   * question - accept-all means nothing stops to ask, and this does not ask,
   * it declines and says why. The user's next message starts a fresh chain.
   */
  const runDesktop = useCallback(async (body: string): Promise<DesktopResult> => {
    const why = stuck(trailRef.current)
    if (why) {
      return { ran: [], refused: why, stopped: null, problems: [], after: null }
    }
    return window.wumpy.desktop.run(body)
  }, [])

  /**
   * Hands the result, and the screen afterwards, back as the user's turn.
   *
   * The same route the screenshot takes, for the same reason: the model has
   * to see what its clicks actually did, and the user has to see the same
   * picture the model got. A plan that half worked says exactly where it
   * stopped, because that is the only thing the model can correct from.
   */
  const onDesktopDone = useCallback(async (result: DesktopResult, after: Attachment | null) => {
    /*
     * The loop this was written for.
     *
     * A desktop sequence is a dozen of these in a row, each carrying a fresh
     * photograph, and none of them is a turn the user typed - so before this
     * one the only compaction triggers were waiting for an Enter that was
     * never coming and a tray the panel never reached while a plan ran.
     */
    await makeRoom()
    const lines = result.refused
      ? [`That did not run: ${result.refused}`]
      : result.ran.map((r) => `${r.ok ? 'did' : 'FAILED'}: ${r.step} (${r.detail})`)
    if (!result.refused && result.ran.some((r) => !r.ok)) {
      lines.push('Everything after the failed step was skipped.')
    }
    /* The user came back to their machine. Say so plainly, because the
       model's next move should be to look rather than to retry. */
    if (result.stopped) lines.push(result.stopped)
    /* Which window it reached into. Wumpy's panel is usually the one in
       front - the user just typed into it - so the names were looked up
       somewhere other than the foreground, and that is worth one line. */
    if (result.acting) {
      lines.push(
        `Wumpy's own panel was in front, so the steps acted on the window behind it: "${result.acting}".`
      )
    }
    /*
     * The trail, which is the memory the pictures cannot be.
     *
     * One entry per step that actually ran, so a refusal adds nothing: the
     * chain is already stopped and a line saying "did not go anywhere" would
     * be a step that never happened. KEEP_PICTURES is 2, deliberately, so
     * from the third step on this is the ONLY thing standing between the
     * model and scrolling back to a screen it read four steps ago.
     */
    if (!result.refused) {
      /* The LAST step of the plan, because that is the one that left the
         screen in the state the print describes. Nearly every plan in this
         loop is one step anyway - that is what makes it a loop. */
      const last = result.ran[result.ran.length - 1]
      trailRef.current.push({
        step: shortStep(last?.step ?? 'a step'),
        screen: screenPrint(after?.elements, after?.bytes ?? 0),
        controls: after?.elements?.length ?? 0
      })
    }
    const trail = trailLines(trailRef.current)
    const circling = circlingNote(trailRef.current)
    /* Asked before the next card gets the chance, so the report can say the
       sequence is over in the same breath as saying what the step did. */
    const halted = stuck(trailRef.current)

    const report = [
      'The plan was carried out automatically. This is a report, not the user',
      'speaking - they have said nothing. What each step did:',
      ...lines,
      /* The same distinction as a look: on a model without vision no picture
         was taken, and claiming an attachment that was never sent is how a
         plan's own report becomes the thing that misleads it. */
      after && after.picture !== false
        ? 'The attached screenshot is the screen as it is now.'
        : after
          ? 'No picture was taken - you cannot read one. These are the controls on screen now.'
          : '',
      ...(after ? namedControls(after) : []),
      /* Last, and in this order: where it has been, that it is back
         somewhere it has been, and whether anything further will run. A
         model reads the end of a report; this is the part it has to act
         on. */
      ...(trail.length ? ['', ...trail] : []),
      circling ? `${NEWLINE}${circling}` : '',
      halted ? `${NEWLINE}STOP: ${halted}` : ''
    ]
      .filter(Boolean)
      .join(String.fromCharCode(10))
    /* This hand-back was already sent without being shown, so until now a
       plan of clicks left nothing in the transcript at all once its card had
       scrolled: the model's answer, and no line saying the screen had been
       touched. A plan that half worked is the case that needs it. */
    chatRef.current.notify(desktopLine(result))
    const sent = chatRef.current.send(
      report,
      'Ran it on my screen',
      after && after.picture !== false ? [after] : undefined,
      true
    )
    /* A turn had started in the meantime, so the report would have vanished -
       and a model that is never told what its own plan did will propose the
       same steps again. It still reaches it, as a fact rather than a question;
       the picture is the part that cannot be carried this way. */
    if (!sent) chatRef.current.notice(report)
  }, [makeRoom])

  /* ------------------------------------------------------------- file writes */

  const writeFile = useCallback(
    (path: string, content: string) => window.wumpy.files.write(path, content),
    []
  )
  const checkWrite = useCallback((path: string, content?: string) => window.wumpy.files.check(path, content), [])

  /**
   * Says what was written, without telling the model the contents back.
   *
   * It just wrote them. Feeding a file's text back as a result invited it to
   * review its own output and "correct" it, which is the loop these cards exist
   * to break.
   *
   * A chip rather than a note since the receipts were unified: the same file
   * written twice in a row is now one line with a two on it.
   */
  const onWritten = useCallback((result: WriteResult, _messageId?: string, content?: string) => {
    if (result.written) record('write', result.path)
    chatRef.current.notify(wroteLine(result))
    /*
     * A page that broke when Wumpy loaded it goes back to the model - the
     * errors, never the file. "Open that file and you can play" was said of
     * a game that crashed on its first frame, and the user found out. Twice
     * per request at most: past that, a person should see it.
     *
     * After the write, not inside it: playing a page through takes up to
     * fifteen seconds, and the card should say "saved" when it is.
     */
    if (!result.written || content === undefined || !/\.(?:html?|py|pyw|cpp|cc|cxx|c|js|mjs|cjs|sh|bash)$/i.test(result.path)) return
    const page = /\.html?$/i.test(result.path)
    chatRef.current.notify(page ? 'Playing the page out of sight…' : 'Checking the code…')
    void window.wumpy.files
      .tested(result.path, content)
      .then((tested) => {
        if (!tested.page && !tested.code) return
        /* A program in another language, the same way: compiled or parsed,
           and a terminal game played in a sandbox; its errors handed back.
           What it needs that is not installed is said, not sent back - the
           model says how to get it. */
        const code = tested.code
        const errors = tested.page?.errors ?? code?.errors ?? []
        const what = tested.page ? 'page' : 'code'
        if (!errors.length) {
          chatRef.current.notify(tested.page ? 'Played the page: no errors' : `Checked the ${LANG_NAME[code!.lang]}: no errors`)
          if (code?.missing.length) chatRef.current.notify(`Not installed here: ${code.missing.map((m) => m.split(' ')[0]).join(', ')}`)
          return
        }
        const history = chatRef.current.messages
        const lastAsked = history.findLastIndex((m) => m.role === 'user' && !m.automatic)
        const rounds = history
          .slice(lastAsked + 1)
          .filter((m) => m.automatic && (m.content.startsWith('Wumpy loaded ') || m.content.startsWith('Wumpy checked '))).length
        if (rounds >= PAGE_ROUNDS) {
          chatRef.current.note(`The ${what} still has errors: ${errors.slice(0, 3).join('; ')}`, true)
          return
        }
        const text = code && !tested.page ? codeErrorText(result.path, code.lang, errors, code.context) : pageErrorText(result.path, errors, tested.page?.context)
        if (!chatRef.current.send(text, `The ${what} had ${errors.length} error${errors.length === 1 ? '' : 's'}`, undefined, true)) {
          chatRef.current.notice(text)
        }
      })
      .catch(() => {})
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
    chatRef.current.notify(openedLine(result))
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
  const onCommandResult = useCallback(async (result: ShellResult, unattended: boolean) => {
    // Recorded by the code that ran it, before anything is interpreted. The
    // model is never asked to remember whether it acted.
    record('command', result.command)
    /* Room first, for the same reason as every other automatic hand-back: a
       command's output is a turn nobody typed, so nothing else was going to
       make room for it. */
    await makeRoom()
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
    /* A silent success is already one chip saying exactly this, and that one
       has to go to the model as well - a change that printed nothing is
       still a change it needs to know about. Two chips in a row saying the
       same thing is the spam this is here to remove, so there is only ever
       one. Both kinds collapse on a repeat; see shared/notify.ts. */
    if (feedback.kind === 'notice') {
      chatRef.current.notice(feedback.text)
      return
    }
    chatRef.current.notify(ranLine(result))
    const report = feedback.text

    /*
     * Sent as a user turn because that is the role the model expects a tool
     * result to arrive in - and sent without being shown, which is the new
     * part. The output used to appear on the user's own side of the panel as
     * a bubble reading "Ran: `dir`", which is Wumpy putting words in their
     * mouth: the same thing they objected to for screenshots, "it makes it
     * look funky, so don't show things like that". The chip above says what
     * happened, in Wumpy's voice, and counts a repeat instead of repeating.
     */
    const sent = chatRef.current.send(report, `Ran: \`${result.command}\``, undefined, true)
    // A turn was already in flight, so the output would otherwise vanish.
    // It still reaches the model, just as a fact rather than a question.
    if (!sent) {
      chatRef.current.notice(
        `Ran \`${result.command}\`:\n${clippedOutput(result) || '(no output)'}`
      )
    }
  }, [makeRoom])

  /* --------------------------------------------------- autosave + compaction */

  /**
   * Character-based fallback, used until the provider reports real counts.
   *
   * Memoised because it walks every message, and the panel re-renders on every
   * token: without this, the cost of counting the conversation was paid once
   * per token and grew with the conversation, while the model was generating.
   *
   * The pictures are counted too, at what one of this app's captures actually
   * costs. Before that they were worth nothing here, which was survivable
   * while a screenshot was a rare thing a user asked for and is not now that
   * every step of a desktop plan returns one: twelve steps is thirteen
   * thousand tokens the meter could not see, in the exact loop that fills the
   * window fastest.
   */
  /**
   * The instructions, which the estimate used to count as nothing.
   *
   * Thirteen thousand tokens go out ahead of every turn - most of what fills
   * the window - so leaving them out meant the meter read 1% immediately
   * after a compaction when the truth was 41%, and a reopened chat looked
   * emptier than it was. Measured from the same assembly the main process
   * sends, by the same settings, so the two cannot disagree.
   */
  /*
   * The same `needs` the sender works out, from the same messages, so the
   * meter follows the preamble up and down instead of always quoting the
   * biggest it could be. A turn about the screen costs 4,700 tokens more
   * than a turn about anything else, and that is now visible rather than
   * averaged away.
   */
  const preamble = useMemo(
    () =>
      preambleTokens({
        scope: (settings?.shellEnabled ?? true) ? 'full' : 'none',
        search: settings?.searchEnabled ?? true,
        screen: settings?.screenEnabled ?? true,
        browser: settings?.browserEnabled ?? false,
        quota: (keyStatus?.counts?.google ?? 0) > 0,
        lean: settings?.leanPrompt ?? false,
        needs: needsFor(messages.filter((m) => !m.error && !m.local))
      }),
    [settings, keyStatus, messages]
  )

  const guessed = useMemo(() => {
    const counted = messages.filter((m) => !m.error && !m.local)
    /*
     * Every attachment, in the order they were sent, charged for what it
     * actually is. A flat 1,100 each was right while an attachment could only
     * be a picture; a 16,000-character text file is four thousand tokens and
     * a .docx that could not be read is one sentence. estimateWithFiles also
     * applies the same "only the newest pictures go out" cap that the wire
     * does, so the meter reports the conversation that is being paid for.
     */
    const files = counted.flatMap((m) => m.images ?? [])
    const chars = counted.reduce((n, m) => n + m.content.length, 0)
    return preamble + estimateWithFiles(chars, files, KEEP_PICTURES)
  }, [messages, preamble])

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
    const estimate = guessed
    // After a turn lands, the counted value is authoritative. Before the first
    // turn, or after loading a saved chat, fall back to characters.
    if (counted !== null && counted >= estimate * 0.5) {
      return { used: counted, limit, estimated: false, instructions: preamble }
    }
    return { used: estimate, limit, estimated: true, instructions: preamble }
  })()

  /**
   * The live figure, for the stable callbacks that hand results back.
   *
   * They cannot list `usage` as a dependency - that would rebuild them on
   * every token - and a closure over the first render's value would compare
   * today's conversation against an empty one.
   */
  const usageRef = useRef(usage)
  usageRef.current = usage

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

      /*
       * Shown for every compaction, including the silent ones. "Silent"
       * meant no chat message, and it also meant no sign at all - so an
       * automatic compaction before a send looked exactly like the app
       * having stopped. The indicator is the one thing that should never
       * be silent.
       */
      setCompacting(true)
      let summary: string | null = null
      try {
        summary = await window.wumpy.chat.compact({
          messages: older.map((m) => ({
            role: m.summary ? 'system' : m.role,
            content: m.content
          }))
        })
      } finally {
        setCompacting(false)
      }

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
      /* For the cooldown: a summary that helped but not enough must not be
         summarised again on the very next hand-back. */
      lastCompact.current = Date.now()
      return true
    },
    [chat]
  )

  /**
   * Summarising in the middle of a task, which is the one case nothing covered.
   *
   * "If the context is above 90% while it's doing something, stop whatever
   * it's doing, compact, and then continue. Because when it's burst the
   * context, it can't do anything."
   *
   * Every automatic hand-back - a command's output, search results, a
   * screenshot, the report from a plan - goes through this first. The two
   * older triggers both needed the user: one fires when they press Enter, the
   * other when the panel is away in the tray, and a desktop sequence does
   * neither for a dozen turns while adding a photograph to each one.
   *
   * Done, then said. A pause with nothing in the panel explaining it looks
   * exactly like the app having stopped, which is the thing the compacting
   * indicator was added for in the first place.
   */
  const makeRoomNow = useCallback(async (): Promise<boolean> => {
    const { used, limit, instructions } = usageRef.current
    if (!(settings?.autoCompact ?? true)) return false
    if (!needsRoom('auto', used, limit, instructions)) return false
    /*
     * Not twice in a minute. A summary that helped but not enough would
     * otherwise be summarised again on the next hand-back, and each attempt
     * is a request out of a tier counted per day.
     */
    if (Date.now() - lastCompact.current < COMPACT_COOLDOWN_MS) return false
    const done = await compactHistory({ silent: true })
    /* The same three numbers the decision was made on, so the sentence and
       the meter quote the same percentage. */
    if (done) chatRef.current.note(roomNote(used, limit, instructions))
    return done
  }, [compactHistory, settings])
  makeRoomRef.current = makeRoomNow

  /**
   * And the case where even that was too late: the provider refused the turn
   * because what was sent was too big.
   *
   * At that point the conversation is unusable - every retry sends the same
   * oversized history and fails the same way, which is what "when it's burst
   * the context, it can't do anything" describes. So the failed pair is
   * dropped, the history is summarised, and the question is asked again.
   *
   * Once per failure, tracked by message id: a compaction that does not shrink
   * enough would otherwise retry forever, each attempt spending a request.
   */
  const retried = useRef(new Set<string>())
  useEffect(() => {
    if (streaming) return
    const failed = messages.findLast((m) => m.error && tooBig(m.error))
    if (!failed || retried.current.has(failed.id)) return
    retried.current.add(failed.id)
    const asked = messages[messages.indexOf(failed) - 1]
    if (!asked || asked.role !== 'user') return
    void (async () => {
      const live = chatRef.current
      const done = await compactHistory({ silent: true })
      if (!done) {
        live.note(
          'That was too much for one request, and there is not enough history to summarise. Start a new chat with /new.',
          true
        )
        return
      }
      live.note('That request was too large, so earlier turns were summarised. Asking again.')
      live.send(asked.content, undefined, asked.images)
    })()
  }, [messages, streaming, compactHistory])

  /**
   * An attachment the endpoint would not take, sent again without it.
   *
   * Images and video are measured as working here. A PDF and a sound file go
   * the same way on the strength of the same finding - the endpoint reads the
   * type off the data URL - and that could not be confirmed, because the API
   * answered 503 and then timed out across four keys while this was written.
   *
   * So rather than claim it works or refuse to send it, the failure is made
   * cheap: the turn goes again with the bytes replaced by a line naming the
   * file, which is what an unreadable attachment gets anyway. One wasted
   * request, an honest answer, and the user is told which it was.
   */
  const retriedBytes = useRef(new Set<string>())
  useEffect(() => {
    if (streaming) return
    const failed = messages.findLast((m) => m.error && refusedAttachment(m.error))
    if (!failed || retriedBytes.current.has(failed.id)) return
    const asked = messages[messages.indexOf(failed) - 1]
    if (!asked || asked.role !== 'user' || !asked.images?.some((a) => sendsBytes(a.kind))) return
    retriedBytes.current.add(failed.id)
    const live = chatRef.current
    const kinds = [...new Set(asked.images.filter((a) => sendsBytes(a.kind)).map((a) => a.kind))]
    live.note(
      `This model would not take ${kinds.join(' or ')} like that. Asking again with the file named but not sent.`
    )
    live.send(asked.content, undefined, withoutBytes(asked.images) as typeof asked.images)
  }, [messages, streaming])

  /**
   * Start a listening session, and say what that means.
   *
   * The sentence is not decoration. This opens a tap on everything the
   * machine is playing and, by default, on the microphone as well - which
   * in a call means every other person in it. Someone should be told that
   * in plain words at the moment it starts, once, rather than discovering
   * it from a transcript later. It is also the only honest place to
   * mention that whether they may do this is not Wumpy's call: one line,
   * no lecture, and never again for the same session.
   */
  const startListening = useCallback(
    async (want: AudioSource, quiet = false): Promise<boolean> => {
      /* The reason comes back from the call. Reading `listening.error` here
         read the render that is still on screen, so it was always null and
         every failure printed the same six words. See start(). */
      const why = await listening.start(want)
      if (why) {
        chat.note(why, true)
        return false
      }
      liveNotes.reset()
      if (quiet) return true
      const what =
        want === 'both'
          ? 'your speakers **and** your microphone'
          : want === 'system'
            ? 'your speakers only — not your microphone'
            : 'your microphone only'
      /*
       * NOTHING TO REMEMBER, and that is now literally true.
       *
       * This used to end by teaching three forms, one of them `/listen
       * what did they say about the deadline`. Then it taught one, which
       * was `/listen` again. There is no such command any more - "remove
       * the command, i like it when i ask it directly" - so what it says
       * is the sentence that stops it, which is also just a sentence.
       */
      chat.note(
        [
          `**Listening** to ${what}. **Live notes** appear here once there is something to note, ` +
            'and keep updating — and correcting themselves — as the meeting goes. Ask me anything ' +
            'about what was said, or say **notes** for a full write-up.',
          '',
          'Say **stop listening** when you are done. Only the text is kept, ' +
            'no audio, and the channels are mixed so it cannot say who spoke.',
          '',
          '_Recording others may need their consent where you are._'
        ].join(NEWLINE)
      )
      return true
    },
    [chat, listening, liveNotes]
  )

  /* ------------------------------------------------- choosing out loud */

  /** A key for it, or none needed. */
  /* A keyless provider is ready when its daemon answers, not because it
     needs no key: see localUp in the main process. */
  const providerReady = useCallback(
    (p: CloudModel['provider']): boolean =>
      PROVIDERS[p].keyless
        ? (keyStatus?.local?.includes(p) ?? false)
        : (keyStatus?.configured.includes(p) ?? false),
    [keyStatus]
  )

  /** The catalogue as one tab orders it, best first: only what can answer now. */
  const readyModels = useCallback(
    (ordering: Ordering): CloudModel[] => {
      const latencies = settings?.latencies ?? {}
      return rankedModels(CLOUD_MODELS, latencies, ordering)
        .filter((r) => providerReady(r.model.provider) && alive(r.model, latencies))
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((r) => r.model)
    },
    [settings?.latencies, providerReady]
  )

  /**
   * `/model` with nobody looking: the five worth knowing about, read out -
   * "the top three overall for balanced, and then the smartest and the
   * fastest" - and a question card that any of them answers, or any other
   * model by name. `ordering` reads one tab's top three instead, for
   * "/model fastest".
   */
  const askModelAloud = useCallback(
    (ordering: Ordering | null): void => {
      const balanced = readyModels('balanced')
      if (!balanced.length) {
        chat.note('No model can answer yet. Add a key with `/key nvidia <key>`.')
        tell('No model is set up yet. Add an NVIDIA key first.')
        return
      }
      const ids = (list: CloudModel[]): string[] => list.map((m) => m.id)
      const labelOf = (id: string): string => CLOUD_MODELS.find((m) => m.id === id)?.label ?? id
      let short: ShortEntry[]
      let intro: string
      if (ordering && ordering !== 'balanced') {
        const why: ShortWhy = ordering === 'smarts' ? 'smartest' : 'fastest'
        const top = readyModels(ordering).slice(0, 3)
        short = top.map((m) => ({ id: m.id, why, top: true }))
        intro = `${why === 'smartest' ? 'Smartest' : 'Fastest'} first: ${spokenAnd(
          top.map((m) => sayModel(m.label))
        )}.`
      } else {
        short = modelShortlist(ids(balanced), ids(readyModels('smarts')), ids(readyModels('speed')))
        intro = shortlistSpeech(short, labelOf)
      }
      const listed = short
        .map((e) => balanced.find((m) => m.id === e.id))
        .filter((m): m is CloudModel => Boolean(m))
      const order = [...listed, ...balanced.filter((m) => !listed.includes(m))]
      /* "The fastest", "the best one": the real top of each list answers to
         it, even when that one was read out among the balanced three and the
         "next fastest" took the fifth place. */
      const top: Record<ShortWhy, string | undefined> = {
        balanced: balanced[0]?.id,
        smartest: readyModels('smarts')[0]?.id,
        fastest: readyModels('speed')[0]?.id
      }
      const aliases = order.map((m) =>
        (Object.keys(top) as ShortWhy[]).flatMap((why) => (top[why] === m.id ? SPOKEN_ALIASES[why] : []))
      )
      const now = CLOUD_MODELS.find((m) => m.id === model)
      /* Asked for by name and not on the list: why, rather than "sorry,
         which one?" - "Deep seek" twice, the week NVIDIA withdrew it. */
      const unavailable = CLOUD_MODELS.filter((m) => !order.includes(m)).map((m) => ({
        names: [m.label],
        why: providerReady(m.provider)
          ? `${sayModel(m.label)} isn't answering right now.`
          : `${sayModel(m.label)} needs a ${PROVIDERS[m.provider].label} key.`
      }))
      const labels = (list: CloudModel[]): string[] => list.map((m) => m.label)
      chat.askLocal('Which model?', order.map((m) => m.label), 'model', {
        values: ids(order),
        say: `${now ? `You're on ${sayModel(now.label)}. ` : ''}${intro}`,
        spoken: listed.length,
        aliases,
        unavailable,
        ranked: { balanced: labels(balanced), smarts: labels(readyModels('smarts')), speed: labels(readyModels('speed')) }
      })
    },
    [chat, model, readyModels, providerReady]
  )

  /**
   * The saved chats, read out with numbers: "they tell me all of them
   * quickly". The most recent twelve first, then - "make sure that it can
   * read out all my chats, when i want to change chats" - the rest, five at
   * a time, each time nobody speaks for a moment, numbered on from
   * thirteen, as the models are. They used to stop at twelve, "and 30
   * older", and the older ones were not on the card at all: nothing could
   * pick them. Every chat is on it now, by name or by number.
   */
  const askChatsAloud = useCallback(
    async (kind: 'resume' | 'deletechat'): Promise<void> => {
      const list = await refreshChats()
      const pool = kind === 'resume' ? list.filter((c) => c.id !== chatId) : list
      if (!pool.length) {
        const none = kind === 'resume' ? 'No other saved chats yet.' : 'No saved chats to delete.'
        say(none)
        tell(none)
        return
      }
      /* Two chats with one title would be one button and one answer. */
      const seen = new Map<string, number>()
      const titles = pool.map((c) => {
        const t = (c.title || 'Untitled').trim()
        const n = (seen.get(t) ?? 0) + 1
        seen.set(t, n)
        return n > 1 ? `${t} (${n})` : t
      })
      const first = Math.min(pool.length, SPOKEN_CHATS)
      const count =
        pool.length > first ? `${pool.length} chats, newest first` : pool.length === 1 ? 'One chat' : `${pool.length} chats`
      chat.askLocal(kind === 'resume' ? 'Which chat?' : 'Delete which chat?', titles, kind, {
        values: pool.map((c) => c.id),
        say: `${count}. ${numberedSpeech(titles.slice(0, first), first)}`,
        spoken: first,
        said: titles
      })
    },
    [chat, chatId, refreshChats, say]
  )

  /** Yes or no, on screen and out loud, before something that cannot be undone. */
  const askConfirm = useCallback(
    (question: string, yes: string, no: string, then: () => void): void => {
      const id = chat.askLocal(question, [yes, no], 'confirm')
      confirms.current.set(id, then)
    },
    [chat]
  )

  /**
   * Restarts Wumpy, saving this chat first so the restarted one opens it
   * again (see restartWumpy in the main process). Through a ref, so a
   * restart asked for by the tray or `wumpy --restart` saves the chat as it
   * is now and not as it was when the listener was attached.
   *
   * The chat is only named for reopening when it was saved here: with
   * autosave off there is no file, and the restarted Wumpy would open on
   * "That chat could not be opened."
   */
  const restartRef = useRef<(why: string) => Promise<void>>(async () => {})
  restartRef.current = async (why: string): Promise<void> => {
    const real = chat.messages.filter((m) => !m.local)
    let keep = false
    if (real.length && (settings?.autoSave ?? true)) {
      keep = await window.wumpy.chats
        .save({ id: chatId, title: chatTitle ?? undefined, messages: chat.messages, titleLocked })
        .then((saved) => saved !== null)
        .catch(() => false)
    }
    window.wumpy.app.restart(keep ? chatId : null, why)
  }
  useEffect(() => window.wumpy.app.onRestartAsked((why) => void restartRef.current(why)), [])

  /* Back on the chat a restart left, once, at startup. */
  useEffect(() => {
    void window.wumpy.app.launchChat().then((id) => {
      if (id) void openChatRef.current(id)
    })
  }, [])

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

        /**
         * All three open a picker over the saved chats, and an empty picker
         * is a bad answer: a search box, a list of nothing, and no reason
         * given. Reported as exactly that. The count comes back from the
         * refresh rather than from state, which has not re-rendered yet.
         */
        case 'chats':
        case 'resume': {
          /* Through the earbuds a picker is a window nobody can see. */
          if (handsFree()) {
            await askChatsAloud('resume')
            return
          }
          if ((await refreshChats()).length === 0) {
            say('No saved chats yet.')
            return
          }
          setPicker('resume')
          return
        }
        case 'delete': {
          /*
           * The one in front of you, unless asked for the list.
           *
           * No confirmation when typed. This is the same answer the user has
           * given three times about accept-all - they own the machine and
           * would rather have the thing happen than be asked - and unlike a
           * command on the filesystem, the cost of being wrong here is one
           * conversation. The chat is named in the confirmation so it is at
           * least obvious WHICH one went.
           *
           * Asked for any other way, it asks first: "delete this chat" in
           * words, "slash delete" into the earbuds, or the model proposing
           * it. "It's going to tell me, are you sure you want to delete this
           * chat? And then I'm going to say yes." A recogniser mishearing
           * is not the user's own hand on the keyboard.
           */
          if (!action.pick) {
            const id = action.chatId ?? chatId
            const current = id === chatId
            const list = await refreshChats()
            const name = current
              ? (chatTitle ?? 'this chat')
              : (list.find((c) => c.id === id)?.title ?? 'that chat')
            if (!action.confirmed && (action.confirm || handsFree())) {
              askConfirm(
                current ? `Delete this chat, "${name}"?` : `Delete "${name}"?`,
                'Delete it',
                'Keep it',
                () =>
                  void runCommandRef.current(
                    { kind: 'delete', pick: false, confirmed: true, chatId: id },
                    '/delete'
                  )
              )
              return
            }
            const saved = list.some((c) => c.id === id)
            if (current) newChat()
            if (saved) await window.wumpy.chats.delete(id)
            await refreshChats()
            say(saved ? `Deleted "${name}".` : 'Started a new chat; there was nothing saved yet.')
            tell(saved ? `Deleted ${name}.` : 'Started a new chat. There was nothing saved yet.')
            return
          }
          if (handsFree()) {
            await askChatsAloud('deletechat')
            return
          }
          if ((await refreshChats()).length === 0) {
            say('No saved chats to delete.')
            return
          }
          setPicker('delete')
          return
        }
        case 'screen': {
          /*
           * The picture goes with the question, in one turn.
           *
           * The long way round is the model proposing a wumpy-screen block
           * and the capture arriving on the turn after - two round trips
           * before it has seen anything. Here the user already knows they
           * want it looked at, so there is nothing to propose.
           *
           * Visible as a normal message, unlike the automatic captures:
           * this one the user asked for, so hiding it would lose the only
           * record of what they sent.
           */
          if (!canSeeScreen) {
            say('Screen capture is turned off in settings.')
            return
          }
          try {
            const shot = await window.wumpy.screen.capture()
            chat.send(
              [
                action.ask || 'What is on my screen?',
                '',
                /* Same two worlds as the model's own look: a photograph, or
                   the names of what is on screen when it cannot read one. */
                ...(shot.picture === false
                  ? [
                      'No picture could be sent - the model you are cannot read one. What is',
                      'on screen is listed below by name. If the question is about how',
                      'something LOOKS, say you cannot see it rather than guessing.'
                    ]
                  : [
                      'A screenshot of my screen is attached. Answer from what is actually',
                      'visible; if something is too small or cut off, say so.'
                    ]),
                ...namedControls(shot)
              ].join(String.fromCharCode(10)),
              action.ask || 'What is on my screen?',
              shot.picture === false ? [] : [shot]
            )
          } catch (err) {
            say(err instanceof Error ? err.message : 'Could not capture the screen.')
          }
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
        /*
         * Which models still answer, one real request each.
         *
         * The "asking" note goes up first and is not decoration: thirteen
         * serial requests take the better part of a minute, and a panel that
         * sat silent through it would read as a command that did nothing -
         * which is how someone ends up running it twice and paying twice.
         */
        case 'models': {
          const runs = action.runs ?? DEFAULT_RUNS
          /*
           * What it will cost, before it costs it. Two runs of six models
           * is twelve requests and can take several minutes, because the
           * slowest entries here answer in about a hundred seconds - and
           * a command that sits silent for that long is one somebody runs
           * again thinking it did nothing.
           */
          /* One line. This was five, explaining why it asks twice and
             what a real preamble costs and how long to wait - all true,
             all already decided, and none of it anything the reader can
             act on while they wait. The cost and the wait are the two
             facts; the reasoning lives in the code. */
          chat.note(
            `Checking ${CLOUD_MODELS.length} models, ${runs} run${runs === 1 ? '' : 's'} each — ` +
              `${CLOUD_MODELS.length * runs} real requests, a few minutes.`
          )
          const results = await window.wumpy.models.probe(runs)
          /*
           * KEPT, not just printed. The check measures the one number the
           * picker's order turns on and used to throw it away: see
           * cloud.Fresh for the afternoon where that put the report's
           * recommendation eighth in the list it was recommending from.
           *
           * Merged rather than replaced, so a run that skipped a model -
           * no key that day, or the id typed by hand - leaves its last
           * known time standing instead of silently deleting it.
           */
          const fresh = {
            ...(settings?.latencies ?? {}),
            ...freshLatencies(results, new Date().toISOString().slice(0, 10))
          }
          await patch({ latencies: fresh })
          chat.note(
            probeLines(
              results,
              model,
              fresh,
              /* The order the report talks about has to be the order the
                 user will see when they open the list. */
              isOrdering(settings?.modelOrder) ? settings.modelOrder : DEFAULT_ORDERING
            ).join(NEWLINE),
            false,
            'probe'
          )
          return
        }

        /**
         * `/model smarts` - change the question the list answers, and show it.
         *
         * No note in the transcript: the picker opens on the tab with its
         * caption under it, which says more about what just changed than a
         * sentence could, and `/settings` carries it afterwards.
         */
        case 'modelorder': {
          await patch({ modelOrder: action.ordering })
          if (handsFree()) askModelAloud(action.ordering)
          else setPicker('model')
          return
        }

        case 'model': {
          if (!action.name) {
            if (handsFree()) askModelAloud(null)
            else setPicker('model')
            return
          }

          // Named directly. A hosted model needs its key first, and a local
          // one has to be installed; anything else would set a tier that
          // cannot answer and fail at the next question instead of here.
          /* "Use the fastest model": the top of that list, of the ones that
             can answer now. Typed, `/model fastest` opens the list on that
             tab instead - this is the sentence, which asks for the model. */
          /* And said every other way: "the most intelligent model", "best
             overall", "a generally efficient one" - see orderingIn. */
          const asked = orderingIn(action.name)
          const ordering =
            readOrdering(action.name.replace(/\s+one$/i, '')) ?? (asked && !asked.rest ? asked.ordering : null)
          const wanted = (ordering && readyModels(ordering)[0]?.id) || action.name
          let hosted = CLOUD_MODELS.find(
            (m) => m.id === wanted || m.label.toLowerCase() === wanted.toLowerCase()
          )

          /*
           * NAMED ROUGHLY, AS PEOPLE DO. "/model nemotron super", "/model
           * gemma", and said aloud "Jemma" or "deep seek": matched on the
           * words of the names (see @shared/spokenpick), never on the
           * exact id nobody remembers. One fit is that model. Several -
           * "Nemotron" is four of them - are offered back, best first,
           * rather than guessed between: "it's going to preview all of the
           * Nemotrons ranked." An id typed in full (a slash or a colon)
           * still goes straight through, for models the list does not have.
           */
          if (!hosted && providerFor(wanted) === null) {
            const ranked = rankedModels(CLOUD_MODELS, settings?.latencies ?? {}, 'balanced')
              .slice()
              .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
              .map((r) => r.model)
            const hits = matchSpoken(
              wanted,
              ranked.map((m) => ({ id: m.id, names: [m.label, m.id] }))
            )
            const fits = hits
              .map((id) => ranked.find((m) => m.id === id))
              .filter((m): m is CloudModel => Boolean(m))
            /* Ready ones first: offering a model that needs a key nobody
               has is offering an error. Unless none of them is. */
            const ready = fits.filter((m) => providerReady(m.provider))
            const offer = ready.length ? ready : fits
            if (offer.length === 1) hosted = offer[0]
            else if (offer.length > 1) {
              chat.askLocal(
                'Which one?',
                offer.map((m) => m.label),
                'model',
                {
                  values: offer.map((m) => m.id),
                  say: `${offer.length} of them: ${numberedSpeech(offer.map((m) => sayModel(m.label)))}`,
                  spoken: offer.length,
                  /* "The fastest one" among these: by the ranking, not the list. */
                  ranked: {
                    balanced: readyModels('balanced').map((m) => m.label),
                    smarts: readyModels('smarts').map((m) => m.label),
                    speed: readyModels('speed').map((m) => m.label)
                  }
                }
              )
              return
            }
          }
          const id = hosted?.id ?? wanted

          /**
           * A TYPO IS NOT A MODEL, and this used to set one.
           *
           * `/model chack` - a mistyped `check` - was accepted whole and
           * the panel said "Now answering with chack." No catalogue
           * entry, no provider, nothing that could ever answer; the
           * status bar read `chack` and the next question would have
           * failed somewhere far away from the mistake.
           *
           * Typing an id by hand has to keep working, because that is
           * the only way to reach a model the catalogue does not list.
           * So the gate is routability rather than membership: an id
           * with a slash or a colon in it goes to a provider, and one
           * with neither goes nowhere and is a slip.
           */
          if (!hosted && providerFor(id) === null) {
            const near = ['check', 'test', 'verify', 'status'].find(
              (word) => word.length === id.length && countDiff(word, id.toLowerCase()) <= 2
            )
            chat.note(
              near
                ? `No model called \`${id}\`. Did you mean \`/model ${near}\`?`
                : `No model called \`${id}\`. \`/model\` lists them, \`/model check\` tests them.`
            )
            /* Through the earbuds, the list to choose from instead. */
            if (handsFree()) {
              tell(`I don't know a model called ${wanted}.`)
              askModelAloud(null)
            }
            return
          }

          /* Keyless providers are exempt: Ollama is this machine, and there
             is no key for the user to add however often they are told to. */
          if (
            hosted &&
            !PROVIDERS[hosted.provider].keyless &&
            !(keyStatus?.configured.includes(hosted.provider) ?? false)
          ) {
            chat.note(
              `**${hosted.label}** needs a ${PROVIDERS[hosted.provider].label} key. ` +
                `Add one with \`/key ${hosted.provider} <key>\`.`
            )
            tell(`${sayModel(hosted.label)} needs a ${PROVIDERS[hosted.provider].label} key first.`)
            return
          }

          /* Keyless, so no key to ask for - but the daemon has to be there.
             Asked fresh, so one started a moment ago counts. */
          if (hosted && PROVIDERS[hosted.provider].keyless) {
            const fresh = await window.wumpy.keys.status()
            setKeyStatus(fresh)
            if (!(fresh.local?.includes(hosted.provider) ?? false)) {
              const daemon = PROVIDERS[hosted.provider].label
              chat.note(
                `**${hosted.label}** runs through ${daemon}, which is not running on this computer. ` +
                  `Start ${daemon}, or pick another model with \`/model\`.`
              )
              tell(`${sayModel(hosted.label)} needs ${daemon}, and it isn't running here.`)
              return
            }
          }

          /* Typed rather than picked, so there IS an answer owed - but
             "now" is a change, and nothing changed. */
          if (id === model) {
            chat.note(hosted ? `Already answering with **${hosted.label}**.` : `Already answering with \`${id}\`.`)
            tell(`Already on ${hosted ? sayModel(hosted.label) : 'that one'}.`)
            return
          }
          await patch({ model: id })
          void window.wumpy.assistant.status().then(setAssistant)
          chat.note(
            hosted ? `Now answering with **${hosted.label}**. ${hosted.blurb}` : `Now answering with \`${id}\`.`,
            false,
            'model'
          )
          tell(`Now on ${hosted ? sayModel(hosted.label) : 'that model'}.`)
          return
        }
        case 'reasoning': {
          const show = action.show === 'toggle' ? !(settings?.showReasoning ?? false) : action.show
          await patch({ showReasoning: show })
          chat.note(`Reasoning ${show ? 'shown' : 'hidden'}.`, false, 'reasoning')
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
        case 'settings': {
          /* Settings may not have arrived yet on a very early run; there is
             nothing true to print until they do. */
          if (!settings) {
            chat.note('Still starting up — try that again in a moment.', true)
            return
          }
          /* The ranking's line comes from the main process, because only
             it knows what the job is actually doing. */
          const rank = await window.wumpy.rank.state()
          chat.note(
            settingsLines(
              settings,
              model,
              pool,
              rankSummary(rank, rank.traffic, rank.lastSweepMs)
            ).join(NEWLINE),
            false,
            'settings'
          )
          return
        }
        case 'rank': {
          if (action.set !== null) await window.wumpy.rank.set({ on: action.set })
          if (action.now) await window.wumpy.rank.set({ now: true })
          const view = await window.wumpy.rank.state()
          /* The count of models measured is the catalogue less what is
             left, which is the honest figure mid-sweep as well as after. */
          const measured = Math.max(0, CLOUD_MODELS.length - view.left)
          chat.note(
            [
              action.now ? '_Starting a sweep — it still waits for you._' : '',
              ...rankLines(view, view.traffic, view.lastSweepMs, measured)
            ]
              .filter(Boolean)
              .join(NEWLINE),
            false,
            'rank'
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

          /*
           * Even with nothing spent, the pool is worth printing: "20 keys,
           * all ready, resets at 08:00" is the answer to "how much have I
           * got", and before this it took a 429 to find out.
           */
          const poolReport = report.pool ? poolLines(report.pool) : []

          /*
           * And what the app itself costs, because that is the other half of
           * "how much is this using" and the only place to see it was Task
           * Manager, where Wumpy is five rows called Electron.
           *
           * Half a second, sampled here rather than kept: a number that is
           * always on screen has to be produced by something always running.
           */
          const footprint = footprintLines(await window.wumpy.usage.footprint())

          if (!report.lines.length) {
            chat.note(
              [
                action.reset
                  ? 'Usage cleared.'
                  : `Nothing used yet today. Answering with \`${report.model}\`.`,
                ...(poolReport.length ? ['', ...poolReport] : []),
                ...(footprint.length ? ['', ...footprint] : [])
              ].join(NEWLINE),
              false,
              'usage'
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
              ...report.lines.filter((l) => l.note).map((l) => `_${l.model}: ${l.note}_`),
              ...(poolReport.length ? ['', ...poolReport] : []),
              ...(footprint.length ? ['', ...footprint] : [])
            ].join(String.fromCharCode(10)),
            false,
            'usage'
          )
          return
        }
        /**
         * `/log` — the timeline, read from the main process.
         *
         * Fetched when asked rather than kept in state: it is a dozen lines
         * of text, it changes when nothing in the panel is happening, and a
         * subscription would mean a message crossing the bridge every time
         * the ranking measured a model.
         */
        case 'journal': {
          if (action.clear) {
            const had = await window.wumpy.journal.clear()
            chat.note(
              had
                ? `Forgot ${had} line${had === 1 ? '' : 's'} of history. ` +
                    'New ones start from now.'
                : 'There was nothing to forget.'
            )
            return
          }
          const entries = await window.wumpy.journal.get()
          const view: JournalView = {
            /* `/log` shows the recent ones; `/log all` and any filtered
               view show the whole day, which is everything kept. */
            limit: action.all ? null : undefined,
            only: action.only
          }
          /* Written as a note that can be rewritten, and remembered as the
             one that keeps up. See the subscription below.

             Tagged, so asking twice rewrites the report rather than printing
             a second copy of it under the first - which is twenty lines of
             transcript saying what the twenty lines above it already said,
             one of them already out of date. */
          liveLog.current = {
            id: chat.liveNote(journalLines(entries, view).join(NEWLINE), 'journal'),
            view
          }
          /* Through the earbuds the listing is columns nobody can hear: the
             same history, said. */
          if (handsFree()) tell(speakable(journalSpeech(entries, view), 700))
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

          /*
           * Which keys are still good.
           *
           * Reported by POSITION, because that is what the main process
           * sends: a key never crosses that boundary, not even masked, so
           * "key 1, 2 and 3" is the most that can be said - and it is
           * enough, since /key google replace <the rest> replaces the list.
           */
          if (action.check) {
            chat.note(`Checking the ${label} keys…`)
            const result = await window.wumpy.keys.check(provider)
            if (!result.ok && !result.keys.length) {
              chat.note(result.why)
              return
            }
            const dead = result.keys.filter((k) => !k.ok)
            const alive = result.keys.length - dead.length
            if (!dead.length) {
              chat.note(
                `All ${result.keys.length} ${label} key(s) still work. ` +
                  'Checked with a models listing, so it cost nothing from today.'
              )
              return
            }
            const reasons = [...new Set(dead.map((k) => k.why).filter(Boolean))]
            chat.note(
              [
                `**${alive} of ${result.keys.length} ${label} keys work.**`,
                '',
                `Refused: key ${dead.map((k) => k.number).join(', ')}.`,
                ...reasons.map((r) => `_${r}_`),
                '',
                'They are out of the rotation now, and stay out across restarts and across ' +
                  'midnight — a refused key is not something waiting fixes.',
                `Drop them with \`/key ${provider} drop ${dead.map((k) => k.number).join(' ')}\`, ` +
                  `or replace the whole list with \`/key ${provider} replace <key…>\`.`
              ].join(NEWLINE)
            )
            setKeyStatus(await window.wumpy.keys.status())
            return
          }

          if (action.drop?.length) {
            const result = await window.wumpy.keys.drop(provider, action.drop)
            if (!result.ok) {
              chat.note(result.why)
              return
            }
            setKeyStatus(await window.wumpy.keys.status())
            void window.wumpy.assistant.status().then(setAssistant)
            chat.note(
              `Removed ${label} key ${result.removed?.join(', ')}. ` +
                `${result.total} left. The day's counts start again, since the positions moved.`
            )
            return
          }

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
                    `\`/key ${provider} <key>\`, replace them all with ` +
                    `\`/key ${provider} replace <key…>\`, or remove them with \`/key ${provider} clear\`.`
                : `No ${label} key yet. Get one at ${PROVIDERS[provider].keyUrl} ` +
                    `and paste it with \`/key ${provider} <key>\`.`
            )
            return
          }

          const before = (await window.wumpy.keys.status()).counts?.[provider] ?? 0
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
          /* An add that changed nothing was a key already saved - said so,
             or "1 stored" after pasting a second one reads as a lost key. */
          const already = action.add && total === before
          chat.note(
            !result.ok
              ? result.why
              : already
                ? `That ${label} key was already saved. ${total} stored. ` +
                    'Each key has to come from a different account.'
                : `${action.add ? 'Added' : 'Saved'} the ${label} key${total === 1 ? '' : 's'}, ` +
                    `encrypted on this computer. ${total} stored` +
                    (total > 1 ? ', used in turn so each limit counts separately. ' : '. ') +
                    'Pick a model with `/model`.'
          )
          return
        }
        case 'setting': {
          /* Both say what they COST rather than reporting a flag: the
             whole point of either is the trade, not the state. */
          if (action.setting === 'thinking') {
            const on = action.on === 'toggle' ? !settings?.thinking : action.on
            await patch({ thinking: on })
            chat.note(
              on
                ? 'Thinking on — it reasons first, so the first word takes longer.'
                : 'Thinking off — straight to the answer.',
              false,
              'thinking'
            )
            return
          }
          const next = action.on === 'toggle' ? !settings?.leanPrompt : action.on
          await patch({ leanPrompt: next })
          chat.note(
            next
              ? 'Short instructions on — about 2,500 fewer tokens a turn.'
              : 'Full instructions on — about 2,500 more a turn.',
            false,
            'lean'
          )
          return
        }
        case 'reflect': {
          if (action.model !== undefined) {
            await patch({ reflect: true, reflectModel: action.model })
            chat.note(
              action.model
                ? `Self-reflection on — the mentor is **${action.model}**.`
                : 'Self-reflection on — the mentor is the same model as the worker.',
              false,
              'reflect'
            )
            return
          }
          const rounds = clampRounds(action.rounds ?? settings?.reflectRounds ?? 3)
          const next = action.on === 'toggle' ? !settings?.reflect : action.on
          await patch({ reflect: next, reflectRounds: rounds })
          chat.note(
            next
              ? `Self-reflection on — when a task is done, a mentor reviews it on your other key ` +
                  `and sends it back until it passes, up to **${rounds}** review${rounds === 1 ? '' : 's'}. ` +
                  '`/reflect off` to stop.'
              : 'Self-reflection off.',
            false,
            'reflect'
          )
          return
        }
        case 'voiceprint': {
          if (action.change === 'calibrate') {
            /* A conversation holds the mic, and the voice read must be the person's alone. */
            if (voiceView().stage !== 'idle' && !FINISHED.has(voiceView().stage)) {
              chat.note('End the conversation first, then `/voice me calibrate`: calibrating needs the mic to itself.', false, 'voiceprint')
              return
            }
            setCalibrating(true)
            return
          }
          const print =
            action.change === 'status'
              ? await window.wumpy.voice.print()
              : await window.wumpy.voice.setPrint(
                  action.change === 'forget' ? { forget: true } : { on: action.change === 'on' }
                )
          chat.note(voiceprintNote(print, action.change), false, 'voiceprint')
          return
        }
        case 'voice': {
          if (action.setting === 'on') {
            const next = action.on === 'toggle' ? !settings?.voiceEnabled : action.on
            await patch({ voiceEnabled: next })
            chat.note(
              next
                ? 'Voice on — **hold the spacebar** and talk, or Ctrl+M for a long one.'
                : 'Voice off.',
              false,
              'voice'
            )
            return
          }
          if (action.setting === 'polish') {
            const next = action.on === 'toggle' ? !settings?.voicePolish : action.on
            await patch({ voicePolish: next })
            chat.note(
              next
                ? /* Where it goes is the whole decision, and this said
                     "the local model" long after there was one. */
                  `Polish on — dictation goes to **${model}** before it reaches the box.`
                : 'Polish off — dictation goes in as heard.',
              false,
              'voice-polish'
            )
            return
          }
          if (action.setting === 'music') {
            const next = action.on === 'toggle' ? !(settings?.pauseMusic ?? true) : action.on
            await patch({ pauseMusic: next })
            chat.note(
              next
                ? 'Music pauses while Wumpy listens and talks, and picks up again after.'
                : 'Music keeps playing while Wumpy listens and talks.',
              false,
              'voice-music'
            )
            tell(next ? 'Music will pause while we talk.' : 'Music will keep playing.')
            return
          }
          const next = action.on === 'toggle' ? !settings?.voiceAutoStop : action.on
          await patch({ voiceAutoStop: next })
          chat.note(
            next
              ? 'Dictation stops when you stop talking.'
              : 'Dictation runs until you press Ctrl+M again.',
            false,
            'voice-autostop'
          )
          return
        }
        case 'listen': {
          if (action.what === 'source') {
            const want: AudioSource =
              action.ask === 'mic' || action.ask === 'me'
                ? 'mic'
                : action.ask === 'both'
                  ? 'both'
                  : 'system'
            if (listening.on) {
              /* Naming a source only means anything at the start, because
                 the tap is already open. Not treated as "stop", which is a
                 thing somebody says on purpose and in words. */
              chat.note('Already listening. Say **stop listening** first, then ask for the one you want.')
              return
            }
            await startListening(want)
            return
          }

          if (action.what === 'unwatch') {
            if (!listening.watching) {
              chat.note('Not watching your screen.')
              return
            }
            listening.unwatch()
            chat.note('Stopped watching your screen. Still listening — say **stop listening** to end that too.')
            return
          }

          if (action.what === 'watch' || action.what === 'monitor') {
            /* "watch my screen" with no meeting running and none named is
               not a reason to open a microphone: said, not guessed. */
            if (!listening.on && action.ask === '') {
              chat.note(
                'I am not listening to a meeting. Say **monitor my PC** to listen and watch your screen together, ' +
                  'or ask me to **look at my screen** for a one-off look.'
              )
              return
            }
            const monitor = action.what === 'monitor'
            const starting = !listening.on
            if (starting) {
              const want: AudioSource = action.ask === 'mic' ? 'mic' : action.ask === 'system' ? 'system' : 'both'
              /* Monitoring says what it is doing in one note, below. */
              if (!(await startListening(want, monitor))) return
            } else if (listening.watching) {
              chat.note(monitor ? 'Already monitoring your PC. Say **stop monitoring** to end it.' : 'Already watching your screen.')
              return
            }
            /* `listening` here is the render before it started; watch() reads
               the live recording, so it is the one to ask. */
            const why = await listening.watch()
            if (monitor && starting) {
              chat.note(
                [
                  '**Monitoring your PC** — listening to your speakers **and** your microphone' +
                    (why ? '.' : ', and looking at your screen about every 20 seconds when it has changed.'),
                  '',
                  '**Live notes** appear here once there is something to note, and keep updating as the meeting ' +
                    'goes — when something changes (a date moves, a decision is reversed) the note is changed, ' +
                    'not repeated. Ask me anything about it, or say **notes** for a full write-up.',
                  '',
                  'Say **stop monitoring** when you are done. Only text is kept — no audio, no screenshots' +
                    (why ? '.' : '; each changed screen is sent to a model that can see, to be read.'),
                  ...(why ? ['', `Not watching your screen: ${why}`] : []),
                  '',
                  '_Recording others may need their consent where you are._'
                ].join(NEWLINE),
                Boolean(why)
              )
              return
            }
            if (why) {
              /* Listening never started: that was already said. */
              if (starting && /^Not listening/.test(why)) return
              chat.note(`Listening, but not watching your screen: ${why}`, true)
              return
            }
            chat.note(
              '**Watching your screen** too. About every 20 seconds, when it has changed, a model that can see ' +
                'notes what is on it — slides, shared documents, names in the call — and those notes join the ' +
                'transcript. The screenshots are sent to that model and not kept. Say **stop watching my screen** ' +
                'to stop.'
            )
            return
          }

          if (action.what === 'notes') {
            const heard = listening.peek()
            if (!heard || wordCount(heard) < ENOUGH_WORDS) {
              chat.note(tooLittle(heard))
              return
            }
            /* Nothing else to do: an ordinary message already carries the
               transcript, so "notes" is one. */
            chat.send(meetingTurn(heard), 'Notes')
            return
          }

          if (action.what === 'stop' && !listening.on) {
            chat.note('Not listening.')
            return
          }

          if (listening.on) {
            const heard = await listening.stop()
            const words = heard ? wordCount(heard) : 0
            chat.note(
              words
                ? `Stopped — ${words} words over ${stamp(elapsed(heard!))}. ` +
                    'The live notes get one last update. Ask me anything about it, or say **notes**. ' +
                    'It stays with this chat until you start a new one.'
                : 'Stopped. Nothing was heard.'
            )
            /* The last minute or so has not been noted yet. */
            void liveNotes.finish(heard)
            return
          }
          await startListening('both')
          return
        }
        case 'pin': {
          const next = action.pinned === 'toggle' ? !pinned : action.pinned
          await patch({ hideOnBlur: !next })
          chat.note(
            next ? 'Staying on top until dismissed.' : 'Will hide when it loses focus.',
            false,
            'pin'
          )
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
          chat.note(APPROVAL_NOTE[next], false, 'approve')
          return
        }
        case 'stop':
          chat.stop()
          return
        case 'help':
          chat.note(helpText(), false, 'help')
          return
        case 'shortcuts':
          chat.note(shortcutsText(), false, 'shortcuts')
          return
        case 'quit':
          window.wumpy.panel.hide()
          return
        case 'startup': {
          const next = action.on === 'toggle' ? !(settings?.launchAtLogin ?? false) : action.on
          await patch({ launchAtLogin: next })
          chat.note(
            next
              ? 'Wumpy now starts in the background when you log in, so the earbuds gesture and the ' +
                  'shortcut work without opening it first. Closing the window only hides it.'
              : 'Wumpy no longer starts when you log in. The earbuds gesture still starts it, a little slower.',
            false,
            'startup'
          )
          tell(next ? 'I’ll start with the computer, in the background.' : 'I won’t start with the computer.')
          return
        }
        case 'restart': {
          const why = raw.trim().startsWith('/') ? '/restart' : `"${raw.trim()}"`
          /* Through the earbuds: say so, and restart once the turn is over
             rather than in the middle of saying it. */
          if (handsFree()) {
            tell('Restarting.')
            afterTurn(() => void restartRef.current(why))
            return
          }
          await restartRef.current(why)
          return
        }
        case 'update': {
          if (update?.stage === 'installing') {
            chat.note('Already updating. Wumpy restarts by itself when the build is done.')
            tell('Already updating.')
            return
          }
          /* On Linux this can be minutes of building, so say so first. */
          if (update?.stage !== 'off') {
            chat.note(
              'Checking for an update. On Linux, if there is one, Wumpy builds it from the source folder and ' +
                'restarts into it — a few minutes, and you can keep using it meanwhile.'
            )
          }
          const result = await window.wumpy.update.now(action.force)
          chat.note(result.message, !result.ok)
          tell(result.ok ? result.message.replace(/\*\*/g, '') : 'The update did not work. The reason is in the panel.')
          return
        }
        case 'skill': {
          const skill = await window.wumpy.skills.get(action.name).catch(() => null)
          if (!skill) {
            chat.note(`There is no skill called “${action.name}”. \`/skills\` lists them.`, true)
            return
          }
          const shown = raw.trim().startsWith('/') ? raw.trim() : `/${skill.name} ${action.args}`.trim()
          chat.send(skillPrompt(skill, action.args), shown)
          return
        }
        case 'sync': {
          if (action.action === 'key' && !action.token) {
            chat.note(
              'Make a token at https://github.com/settings/tokens/new?scopes=gist&description=Wumpy%20skills ' +
                '(only the **gist** scope is needed), then type `/sync key <token>`. It is kept encrypted on this device.'
            )
            return
          }
          if (action.action === 'on' || action.action === 'now' || action.action === 'key') chat.note('Syncing your skills…')
          const result = await window.wumpy.skills.sync({ action: action.action, token: action.token })
          if (result.changed) void window.wumpy.skills.list().then(setSkillCommands).catch(() => undefined)
          const first = action.action === 'on' || action.action === 'key'
          chat.note(
            result.ok && first
              ? `**Sharing skills between your devices.** ${result.message[0].toUpperCase()}${result.message.slice(1)}. ` +
                  `They are kept in an unlisted gist on ${result.account ? `the GitHub account **${result.account}**` : 'your GitHub account'} — anyone with its link could read them, so ` +
                  'keep secrets out of skills. Every device using the same account gets them, every 30 minutes ' +
                  'and soon after one is saved. `/sync off` stops it.'
              : result.ok && action.action === 'now'
                ? `Skills synced: ${result.message}.`
                : result.message,
            !result.ok
          )
          return
        }
        case 'skills': {
          const ask = action.ask
          if (/^(folder|open|dir|edit|files?)$/i.test(ask)) {
            const dir = await window.wumpy.skills.folder(true)
            chat.note(
              `Opened your skills folder: \`${dir}\`. Each skill is a folder with a \`SKILL.md\` in it — change one, ` +
                'or add a folder of your own, and it is a command the next time the panel opens.'
            )
            return
          }
          const making = /^(?:new|add|make|create)\b\s*([\s\S]*)$/i.exec(ask)
          if (making) {
            const what = making[1].trim()
            /* The skill for making skills, when it is there; otherwise the plain ask. */
            const creator = await window.wumpy.skills.get('skill-creator').catch(() => null)
            /* With nothing said, skill-creator asks what it should do; the plain ask cannot. */
            if (!what && !creator) {
              chat.note('Say what it should do: `/skills new <what it should do>` — for example `/skills new turn my notes into a weekly status update`.')
              return
            }
            chat.send(
              creator
                ? skillPrompt(creator, what)
                : `Make me a new skill: ${what}\n\nAsk at most two short questions if something important is unclear; ` +
                    'otherwise write it now, as a <skill> tag with name, description (what it does and when to use it), ' +
                    'triggers and argument-hint, and instructions written to yourself: a title, the method as numbered ' +
                    'steps, the rules that stop the obvious failure, and the shape of the answer. Put $ARGUMENTS where ' +
                    'what follows the command belongs.',
              raw.trim()
            )
            return
          }
          const list = await window.wumpy.skills.list().catch(() => [])
          setSkillCommands(list)
          /* On the earbuds the table is nothing: the names, said, and how to run one. */
          tell(skillsAloud(list.filter((sk) => sk.command)))
          const dir = await window.wumpy.skills.folder(false).catch(() => '')
          chat.note(
            [
              list.length ? '**Your skills** — each one is a command:' : '**No skills yet.**',
              '',
              ...(list.length
                ? [
                    '| Command | What it does | On earbuds, say |',
                    '| --- | --- | --- |',
                    ...list.map(
                      (sk) =>
                        `| \`/${sk.name}\`${sk.builtin ? '' : ' · yours'}${sk.argumentHint ? ` ${sk.argumentHint.replace(/\|/g, '\\|')}` : ''} | ${shortly(sk.description).replace(/\|/g, '\\|')} | “use ${skillSaidAs(sk).replace(/\|/g, '\\|')} on …” |`
                    ),
                    ''
                  ]
                : []),
              '**Add one:** `/skills new <what it should do>`, or just say “make a skill that…”.',
              `**Change one:** \`/skills folder\` opens ${dir ? `\`${dir}\`` : 'the folder'} — each skill is \`<name>/SKILL.md\`, ` +
                'in the same layout as Claude’s. A built-in one you change is kept as yours.'
            ].join(NEWLINE)
          )
          return
        }
        case 'prompt':
          chat.send(action.text, raw)
          return
        case 'none':
          return
      }
    },
    [chat, listening, liveNotes, newChat, openChat, patch, pinned, refreshChats, retitle, settings, startListening, update]
  )

  const onSend = useCallback(
    (text: string, images?: Attachment[]) => {
      // Typing is the person rejoining the loop, so the unattended budget and
      // the already-ran list start again — whichever path the message takes
      // from here, including the auto-compact one that used to skip the reset.
      setAutoRuns(0)
      autoRunsRef.current = 0
      ranCommandsRef.current = []
      /* And the trail of where a plan of clicks has been, for the same
         reason and with one more: a sequence that was stopped for going in
         circles is stopped until they say something, so this is the way out
         of it. "Carry on" is a fresh chain. See @shared/circling. */
      trailRef.current = []
      // Anything they say starts things again after a stop time came - and
      // may itself set one, or take one back. See @shared/deadline.
      deadline.halt(false)
      heardDeadline(text)

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
         *
         * A prompt wrapper is the exception, and missing it is why `/btw`
         * looked broken. `/btw`, `/plan`, `/explain` and the rest are not
         * instructions to the app at all - they are a message for the model
         * with wording around it. Running one immediately meant calling
         * chat.send() while a request was already active, which it refuses,
         * so the line was dropped in silence.
         */
        const command = parseCommand(text)
        if (command && command.kind !== 'prompt') {
          void runCommand(command, text)
          return
        }

        setQueued((rest) => [...rest, text])
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

      /**
       * WHILE IT IS LISTENING, ASKING ABOUT THE MEETING IS JUST ASKING.
       *
       * This was `/listen what did they say about the deadline`, and the
       * report on that was the right one: "that's too long. How am I
       * supposed to remember this?"
       *
       * Nobody should have to. A transcript Wumpy is actively building is
       * context for the conversation, the way the screen or an attachment
       * is - not a thing you address with a command. So every message
       * carries it, including `notes`, and there is no word left to
       * remember at all: the thing that started it was a sentence.
       *
       * It costs tokens, which is why it is bounded rather than clever:
       * only while a session exists in this chat, said out loud when it
       * starts, and gone with `/new`. `meetingTurn` tells the model in as
       * many words to ignore the transcript when the message is not about
       * the meeting, because "what is the weather" will arrive with an
       * hour of somebody's standup attached to it.
       *
       * FROM THE FIRST WORD, not from the thirtieth. "allow it to answer
       * while its listening" - and it would not: eleven seconds into a
       * session, "what are we doing" fell straight past this branch for
       * having eight words of transcript, and went to the model as a bare
       * three-word question with no meeting attached to it. ENOUGH_WORDS
       * exists to stop a summary being invented from ten seconds of speech,
       * which is a write-up problem; it was never a reason to answer a
       * question about the meeting without the meeting. So the gate stays
       * on `notes` below and nowhere else, and while a session is live even
       * an empty transcript goes - `meetingTurn` says it is empty, which is
       * itself the answer to "what are we doing" in the first few seconds.
       */
      const heard = listening.peek()
      if (heard && (listening.on || wordCount(heard) > 0)) {
        /* The write-up is the one thing that needs enough to write from. */
        if (wantsNotes(text) && wordCount(heard) < ENOUGH_WORDS) {
          chat.note(tooLittle(heard))
          return
        }
        /* Sent wrapped, shown as typed: the transcript is thousands of
           words and belongs in the request, not on the screen. */
        chat.send(meetingTurn(heard, text), text, images)
        return
      }

      // Compact before sending when the context is filling up, so the model
      // never silently loses the start of the conversation.
      if (
        (settings?.autoCompact ?? true) &&
        needsRoom('send', usage.used, usage.limit, usage.instructions)
      ) {
        void (async () => {
          const done = await compactHistory({ silent: true })
          if (done) chat.note('Compacted earlier turns to make room.')
          chat.send(text, undefined, images)
        })()
        return
      }

      chat.send(text, undefined, images)
    },
    [chat, compactHistory, listening, runCommand, settings, streaming, usage.used]
  )

  runCommandRef.current = runCommand

  /**
   * One of Wumpy's own commands that the model proposed in a wumpy-app
   * block, and the user said yes to - on the card, with Ctrl+Enter, or out
   * loud. Parsed like a typed line, so it reaches nothing typing cannot; and
   * a delete goes through as already confirmed, because the card WAS the
   * confirmation. See AppCard.
   */
  const runApprovedCommand = useCallback(
    (line: string): void => {
      const action = parseCommand(line)
      if (!action) return
      void runCommand(action.kind === 'delete' ? { ...action, confirmed: true } : action, line)
    },
    [runCommand]
  )

  /**
   * A command named in an answer, run by clicking it.
   *
   * The instructions tell Wumpy to answer "rename this chat" with `/rename`
   * and nothing else, which it does, and until now that was where it ended:
   * the user read a command and typed it out. Same for every "did you mean"
   * and every usage line.
   *
   * It goes through parseCommand like a typed line, so a chip cannot reach
   * anything typing cannot, and `readCommandChip` has already decided the
   * command is one that may be offered at all.
   */
  const runNamedCommand = useCallback(
    (command: string): void => {
      const action = parseCommand(command)
      if (action) void runCommand(action, command)
    },
    [runCommand]
  )

  /**
   * Compacting while nothing is happening, instead of in the user's way.
   *
   * Asked for: "sometimes when context is above 60%, compact while its not
   * used, when it's idle." The send-time compaction it supplements fires at
   * the worst possible moment - the user has just pressed Enter and the
   * first thing that happens is a wait on a different model. In a gap it
   * costs the same request and nobody is waiting on it.
   *
   * 60%, under the 65% the send-time path uses, so the idle attempt gets
   * there first and that one becomes the fallback it was meant to be.
   */
  useEffect(() => {
    if (!(settings?.autoCompact ?? true)) return
    if (streaming || compacting) return
    /*
     * Only while it is away in the tray.
     *
     * "The compaction while idle should happen while it's hidden inside the
     * tray." Twenty seconds without a keystroke is not idle - it is someone
     * reading the answer - and rewriting the history underneath them while
     * they read it is the opposite of out of the way. Hidden is the only
     * state where nobody is looking.
     */
    if (!tucked) return
    if (!needsRoom('idle', usage.used, usage.limit, usage.instructions)) return
    /* A few seconds after it goes away, not twenty: the panel being gone
       is already the evidence that nobody is waiting. */
    const timer = setTimeout(() => {
      void (async () => {
        /* Re-checked on the way in: twenty seconds is long enough for a turn
           to have begun, and compacting under a live request would cut the
           history out from under it. */
        if (chatRef.current.streaming) return
        const done = await compactHistory({ silent: true })
        if (done) chatRef.current.note('Compacted earlier turns while away, to make room.')
      })()
    }, 5_000)
    return () => clearTimeout(timer)
  }, [settings, streaming, compacting, tucked, usage.used, compactHistory])

  /**
   * How much of a long transcript is in the page.
   *
   * Reset on a new or reopened chat, so switching conversations does not
   * carry one chat's reveal over to the next.
   */
  const hidden = hiddenCount(messages.length, revealed)
  const folded = foldsTranscript(messages.length, revealed)
  /**
   * What the transcript draws.
   *
   * Turns the app sent on the user's behalf are left out. They still go to
   * the model and are still in `messages`, so nothing about the conversation
   * changes - they simply are not drawn as something the user said, because
   * they did not say it: "I notice that I auto-send something to it, which
   * is how it probably works, but it makes it look funky, so don't show
   * things like that."
   *
   * Filtered after the fold is computed, so hiding one does not quietly
   * change how much of the history is on screen.
   */
  const shown = useMemo(
    () => messages.slice(firstShown(messages.length, revealed)).filter((m) => !m.automatic),
    [messages, revealed]
  )
  const revealMore = useCallback(() => setRevealed((r) => r + REVEAL_STEP), [])

  /* ------------------------------------------------------- the stop time */

  /**
   * "Do not continue past 10:30": the time is read out of what they said,
   * said back, and kept here. When it comes, the answer is stopped, the agents
   * are stopped, and nothing goes out on its own until they speak again.
   *
   * Checked every few seconds against the clock rather than one long timeout:
   * a laptop asleep across 10:30 wakes to a timeout that still has hours to
   * run, and the stop must happen the moment it wakes.
   */
  const [stopAt, setStopAt] = useState<number | null>(null)
  const heardDeadline = useCallback((text: string) => {
    const now = Date.now()
    const heard = deadlineIn(text, now)
    if (!heard) return
    if (heard.kind === 'clear') {
      if (deadline.get() === null) return
      deadline.set(null)
      setStopAt(null)
      setTimeout(() => chatRef.current.note(DEADLINE_CLEARED_TEXT))
      return
    }
    deadline.set(heard.at)
    setStopAt(heard.at)
    // A moment later, so it is said under their message rather than above it.
    setTimeout(() => chatRef.current.note(deadlineSetText(heard.at, now)))
  }, [])

  useEffect(() => {
    if (stopAt === null) return
    const due = (): void => {
      if (Date.now() < stopAt || deadline.get() !== stopAt) return
      deadline.set(null)
      deadline.halt(true)
      setStopAt(null)
      chatRef.current.stop()
      void window.wumpy.agents
        .list()
        .then(({ agents }) => {
          for (const a of agents) {
            if (a.status === 'queued' || a.status === 'working' || a.status === 'reviewing') {
              void window.wumpy.agents.stop(a.id)
            }
          }
        })
        .catch(() => undefined)
      chatRef.current.notice(deadlineDueText(stopAt))
    }
    due()
    const timer = setInterval(due, 2000)
    return () => clearInterval(timer)
  }, [stopAt])

  /**
   * Stop, and put the question back if it was withdrawn rather than cut off.
   *
   * One place, because there are three ways to stop - Escape, Ctrl+C and the
   * Stop button - and they should not disagree about this.
   */
  const stopAndMaybeEdit = useCallback(() => {
    const giveBack = chat.stop()
    if (giveBack) setPrefill(giveBack)
  }, [chat])

  /**
   * Sends what was typed during the last answer, once that answer has landed.
   *
   * A frame later, so the turn that just finished has settled its state before
   * the next one starts from it.
   */
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend

  /* A spoken turn (wumpy --voice): the same send as typing, so commands and
     intents work by voice; see hooks/useVoiceTurn. */
  useVoiceTurn({
    send: (text) => onSendRef.current(text),
    streaming: () => chatRef.current.streaming,
    messages: () => chatRef.current.messages,
    stop: () => void chatRef.current.stop()
  })

  /* Self-reflection (/reflect): a mentor reviews each finished task and sends
     it back until it passes; see hooks/useReflect and shared/reflect. */
  useReflect({
    enabled: settings?.reflect ?? false,
    rounds: settings?.reflectRounds ?? 3,
    streaming,
    messages,
    send: (text) => chatRef.current.send(text, undefined, undefined, true),
    liveNote: (content) => chatRef.current.liveNote(content),
    update: (id, content) => chatRef.current.update(id, content)
  })
  /* Background agents: started when an answer asks, reported back when the
     chat is idle. See hooks/useAgents and @shared/agents. */
  useAgents({
    chatId,
    streaming,
    streamingId,
    messages,
    send: (text, shown) => chatRef.current.send(text, shown, undefined, true),
    note: (content) => chatRef.current.note(content),
    notify: (content) => chatRef.current.notify(content)
  })
  /* What the line under the last answer says: finished, still going, or
     stopped short. See @shared/turnend. */
  const agentState = useAgentState()
  const commandsRunning = useSyncExternalStore(onPendingChange, runningCount)
  const lastMessage = messages.length ? messages[messages.length - 1] : null
  const spokeAt = [...messages].reverse().find((m) => m.role === 'user' && !m.automatic)?.createdAt ?? 0
  const lastAnswerId = [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null
  const commandsWaiting = useSyncExternalStore(onPendingChange, () => pendingIn(lastAnswerId))
  const ending = turnEnd({
    agents: agentState.agents
      .filter((a) => a.chatId === chatId && (a.status === 'queued' || a.status === 'working' || a.status === 'reviewing'))
      .map((a) => a.title),
    /* Not one a later agent took over: a failed Tetris that the chat handed
       to a second agent is that agent's job now, and red would outlast it. */
    failedAgents: agentState.agents
      .filter(
        (a) =>
          a.chatId === chatId &&
          a.status === 'failed' &&
          (a.endedAt ?? 0) >= spokeAt &&
          !agentState.agents.some(
            (b) => b.chatId === chatId && b.id !== a.id && b.startedAt > a.startedAt && (b.thing ?? b.title) === (a.thing ?? a.title)
          )
      )
      .map((a) => a.title),
    running: commandsRunning,
    waiting: commandsWaiting,
    error: Boolean(lastMessage?.error),
    cutOff: Boolean(lastMessage?.role === 'assistant' && lastMessage.cutOff && !lastMessage.error),
    stopAt
  })
  /* Going to done waits a moment: a command's output goes back to the
     model as soon as it ends, and without this the line went grey for the
     beat before the next answer started - a flicker of "finished" in the
     middle of the work. Anything else changes at once. */
  const [ended, setEnded] = useState(ending)
  const endingKey = `${ending.tone}|${ending.label}|${ending.detail}`
  useEffect(() => {
    if (ending.tone === 'done' && ended.tone === 'going') {
      const timer = setTimeout(() => setEnded(ending), END_GRACE_MS)
      return () => clearTimeout(timer)
    }
    setEnded(ending)
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endingKey])
  useEffect(() => {
    if (streaming || queued.length === 0) return
    const [text] = queued
    /**
     * The queue is emptied INSIDE the timer, not before it.
     *
     * Clearing it first changed `queued`, which is a dependency of this
     * effect, so React tore the effect down - and the cleanup cancelled the
     * very timeout that had just been scheduled. The effect then re-ran,
     * found an empty queue and returned. Nothing was ever sent, which is
     * exactly what "queued messages do not work" looked like.
     */
    const timer = setTimeout(() => {
      setQueued((rest) => rest.slice(1))
      onSendRef.current(text)
    }, 60)
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

  /**
   * And when something already in the transcript grows: an agent card adding
   * its steps, a command's output arriving, a card that resolves into its
   * result. None of them change the messages, so the pin above never saw
   * them - watching an agent work, its card grew down out of view while the
   * panel sat still. Only while you are at the bottom, as above.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sizes = new ResizeObserver(() => pinToBottom())
    const watch = (): void => {
      sizes.disconnect()
      for (const child of Array.from(el.children)) sizes.observe(child)
    }
    watch()
    const added = new MutationObserver(watch)
    added.observe(el, { childList: true })
    return () => {
      added.disconnect()
      sizes.disconnect()
    }
  }, [pinToBottom, picker])

  /**
   * A new answer brings you to it, wherever you had scrolled to.
   *
   * pinToBottom only moves the view while you are already at the bottom,
   * which is right during a reply - it stops the page yanking itself about
   * while you read back through one. It is wrong at the START of a reply:
   * you asked a question, the answer is arriving somewhere below the fold,
   * and the panel is showing you the middle of an older turn.
   *
   * So the stick is re-armed once, on the edge where a turn begins, rather
   * than continuously. Scrolling up during the answer still detaches, and
   * stays detached until the next one.
   */
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (streaming && !wasStreaming.current) {
      stickToBottom.current = true
      setAtBottom(true)
      const el = scroller.current
      if (el) el.scrollTop = el.scrollHeight
    }
    wasStreaming.current = streaming
  }, [streaming])

  /**
   * What the pool looks like now: on arrival, when a turn ends, and when the
   * panel comes back out of the tray.
   *
   * A turn is the only thing that spends quota, and being summoned is the
   * only moment the number is about to be read, so between them there is
   * nothing a poll would catch.
   */
  useEffect(() => {
    if (streaming || tucked) return
    let alive = true
    void window.wumpy.usage.get().then((r) => {
      if (alive) setPool(r.pool)
    })
    return () => {
      alive = false
    }
  }, [streaming, tucked, model])

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

  /**
   * Steps between the panel's four parts.
   *
   * The pieces inside each part were already navigable - arrows between a
   * card's buttons, arrows in a picker, history in the box - and getting
   * from one part to another was the hole. The composer holds the caret
   * almost always, Tab from there walks forward into the transcript, and
   * Shift+Tab was spent on the approval mode, so the header's buttons and
   * the status bar's could be reached only by tabbing forward through every
   * message on screen until it wrapped round. Pinning, moving the panel,
   * changing the model and reading the quota were mouse-only in practice.
   *
   * Where it lands is the part worth being careful about. The newest
   * proposal, if there is one, because that is what the keys are nearly
   * always for and it is the same end Ctrl+Down picks. Otherwise the first
   * control in the strip. Otherwise the transcript itself, which is
   * focusable for exactly this reason: landing nowhere is indistinguishable
   * from the key not working.
   *
   * Returns whether it moved, so the keystroke is only swallowed when
   * something happened. See keyboard.ts for the ring itself.
   */
  const stepRegion = useCallback((back: boolean): boolean => {
    const landing = (region: Region): HTMLElement | null => {
      const container = document.querySelector<HTMLElement>(REGION_SELECTOR[region])
      if (!container) return null
      if (region === 'composer') return container.querySelector<HTMLTextAreaElement>('textarea')
      if (region === 'transcript') {
        const cards = container.querySelectorAll<HTMLElement>('.cmd, .ask')
        const newest = cards[cards.length - 1]?.querySelector<HTMLElement>(
          'button:not([disabled])'
        )
        if (newest) return newest
      }
      const items = focusablesIn(container)
      const at = entryIndex(region, items.length)
      if (at >= 0) return items[at] ?? null
      /* Nothing to land on. The transcript still takes the keystroke - the
         scroller itself is the landing spot, and the arrow keys scroll it
         from there. A strip with no controls is genuinely nowhere to go. */
      return region === 'transcript' ? container : null
    }

    const target = regionAfter(regionOf(document.activeElement), back, (r) => landing(r) !== null)
    const el = target ? landing(target) : null
    if (!el) return false
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
    return true
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
        if (streaming) stopAndMaybeEdit()
        else if (picker) setPicker(null)
        // An app window is not dismissed by Esc - only the overlay is.
        else if (!APP_WINDOW) close()
        return
      }

      /**
       * Ctrl+Tab walks the panel's parts; Ctrl+Shift+Tab walks them back.
       *
       * This was F6 alone, which is the Windows convention and which nobody
       * remembers: "don't make it too hard to remember - like function 16,
       * like what the hell, function 6, like what the hell". Fair. Tab
       * already means "the next thing" and this app already uses Ctrl for
       * the bigger version of a key's meaning, so Ctrl+Tab is the same idea
       * with nothing to memorise.
       *
       * F6 stays as well. It costs one line, it is what a Windows user may
       * try first, and if Chromium ever swallows Ctrl+Tab the way a browser
       * with tabs would, the panel is still navigable.
       *
       * Unmodified apart from Shift in the F6 case: Ctrl+F6 and Alt+F6 mean
       * other things in other apps and nothing here, so they are left alone.
       */
      if ((e.key === 'Tab' && e.ctrlKey && !e.altKey) || (e.key === 'F6' && !e.ctrlKey && !e.altKey)) {
        if (stepRegion(e.shiftKey)) e.preventDefault()
        return
      }

      /*
       * Ctrl+/ prints the shortcuts.
       *
       * This was F1, which is not ours to take: "don't use my f1 or f2 those
       * are essential". The panel floats over whatever the user was working
       * in, so a key that matters there matters while this is open too.
       *
       * Ctrl+/ is what most applications use for exactly this, and / is
       * already the key that starts a command here. Ctrl+? is accepted with
       * it - the same chord with Shift held, which is how people type a
       * question mark and how some layouts reach the slash at all.
       */
      if (e.ctrlKey && !e.altKey && (e.key === '/' || e.key === '?')) {
        e.preventDefault()
        void runCommand({ kind: 'shortcuts' }, '/shortcuts')
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
        if (e.key.toLowerCase() === 'd' && !APP_WINDOW) {
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
        if (e.key.toLowerCase() === 'p' && !APP_WINDOW) {
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
          /**
           * Bailing out straight away hands the question back.
           *
           * Pressing this a second after sending nearly always means "wait,
           * let me reword that", and having to fish the line back out with
           * the up arrow is a step nobody wants. See abort.ts for where the
           * line between that and "stop, I have read enough" is drawn.
           */
          stopAndMaybeEdit()
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
        /* It used to say this whether or not anything was copied: the page's
           clipboard needs document focus, which this window often lacks, and
           the rejection went to the console as an unhandled NotAllowedError.
           Now it reports what happened. */
        void copyText(last.content).then((ok) =>
          chat.note(ok ? 'Copied the last answer.' : 'Could not copy it to the clipboard.', !ok)
        )
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

      /**
       * Shift+Tab cycles approval mode, as it does in Claude Code - but only
       * from the box.
       *
       * It used to take the chord everywhere, and Shift+Tab is the only way
       * back through a row of controls: anywhere but the composer, this made
       * the keyboard one-directional. You could step into the header with
       * Ctrl+Tab and then only ever go forward, and the fourth press changed what
       * runs without asking instead of moving focus - which is not a key you
       * want to press by accident while looking for the pin.
       *
       * The composer is where it is for, and where it is safe: Tab out of
       * the box still works, and nothing in the box is a control to walk
       * back to. Focus on nothing counts as the box, because that is where
       * it is about to be put.
       */
      if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        const from = regionOf(e.target as Element | null)
        if (from !== null && from !== 'composer') return
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
  }, [chat, close, newChat, retitle, runCommand, scrollBy, stepMessage, stepRegion, picker, streaming, stopAndMaybeEdit])

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
      /* A keyless provider is ready when its daemon answers: Ollama runs on
         this machine and is authorised there, so "needs a key" would be
         advice nobody can follow - and "ready" on a machine without it
         was a row that failed every message. */
      const usable = (p: (typeof CLOUD_MODELS)[number]['provider']): boolean =>
        PROVIDERS[p].keyless
          ? (keyStatus?.local?.includes(p) ?? false)
          : (keyStatus?.configured.includes(p) ?? false)

      /*
       * Ordered by what each one scored, not by the order they were typed
       * into the catalogue, and badged with its place. The thing being
       * chosen between here IS how good they are, and that used to be a
       * clause halfway through the blurb.
       */
      /*
       * …and re-ordered by whatever `/model check` last found, which is the
       * same measurement taken more recently on this machine. See
       * cloud.Fresh: the catalogue's times are from one October afternoon,
       * and two of them had already crossed the usable/unusable line by the
       * next day.
       */
      /*
       * …and sorted on whichever of the two numbers the user asked for.
       *
       * The list had one order, and it was the compromise: score first,
       * speed charged gently, nothing past the usable floor. A good
       * default and a bad only option, because the cleverest model here
       * takes a hundred and twelve seconds and the quickest gets twenty
       * of forty-two rungs wrong - so "best" depended on a question
       * nobody had been asked. Three tabs now ask it. See @shared/order.
       */
      const latencies = settings?.latencies ?? {}
      const ordering: Ordering = isOrdering(settings?.modelOrder)
        ? settings.modelOrder
        : DEFAULT_ORDERING
      const cloudItems = rankedModels(CLOUD_MODELS, latencies, ordering)
        .slice()
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map(({ model: m, rank }) => {
          const ready = usable(m.provider)
          const tag = modelTag(m, rank, latencies, ordering)
          /* Beside the blurb, never instead of it: the blurb is a sentence
             somebody wrote and the fresh time is a number somebody measured,
             and rewriting the first from the second is how a caveat
             disappears. Only when they disagree - see freshNote. */
          const note = ready ? freshNote(m, latencies) : null
          return {
            id: m.id,
            title: m.label,
            meta:
              `${PROVIDERS[m.provider].label}  ·  ${
                ready
                  ? m.blurb
                  : PROVIDERS[m.provider].keyless
                    ? 'not running on this computer'
                    : 'needs a key — /key ' + m.provider
              }` +
              (note ? `  ·  ${note}` : ''),
            ...(tag ? { tag } : {}),
            /*
             * Which ones can actually see. It was only findable by reading
             * a blurb - "the only one here that can read a picture" - so
             * the one property that decides whether a screenshot is worth
             * sending was the one you had to read a sentence to learn.
             */
            ...(m.sees
              ? {
                  /*
                   * The score, where there is one, rather than the bare
                   * word. "vision" says a model decodes an image; it
                   * does not say whether it can read eight-pixel text
                   * out of the right box, and those are different
                   * models. The ladder measures that in six rungs and
                   * the number was sitting unused in the catalogue.
                   *
                   * Bare "vision" still appears for an entry nobody has
                   * put through it - absent now means sighted, so a new
                   * model claims eyes before anyone has checked them,
                   * and a missing score should look missing rather than
                   * perfect.
                   */
                  /*
                   * A SCORE OUT OF ONE IS NOT A SCORE.
                   *
                   * deepseek reads images - proved by asking - and is
                   * slow enough that the ladder got through a single
                   * rung before giving up, half of which timed out. That
                   * lands in the catalogue as 0/1, and "vision 0/1" on a
                   * badge reads as "failed the eye test" when the truth
                   * is the opposite: it sees, it is just too slow to
                   * measure properly.
                   *
                   * So a number is shown only when enough rungs ran to
                   * mean something, and anything thinner falls back to
                   * the bare word - which claims only what is actually
                   * known, that pictures get sent.
                   */
                  badge: {
                    text: m.vision && m.vision.of >= 3 ? `vision ${m.vision.clean}/${m.vision.of}` : 'vision',
                    title:
                      m.vision && m.vision.of >= 3
                        ? `Read ${m.vision.clean} of ${m.vision.of} test images, ` +
                          `${m.vision.medianMs}ms each — colour, counting, and text down to ` +
                          `eight pixels inside a named box. Measured ${m.vision.on}.`
                        : 'Sends pictures to this model. How well it reads them has not been ' +
                          'measured — run the vision ladder to find out.'
                  }
                }
              : {}),
            active: m.id === current
          }
        })

      return {
        heading: 'Model',
        placeholder: 'Filter models…',
        emptyText: 'No models. Add a key with `/key`.',
        onClose: close,
        /* The order is remembered, not asked again every visit: somebody
           who wants the quickest thing on the list wants it next week
           too. Nothing else about the picker is a setting, which is why
           the tabs look like a control rather than like rows. */
        tabs: {
          items: ORDERINGS.map((o) => ({ id: o.id, label: o.label, tag: o.tag })),
          active: ordering,
          note: orderNote(ordering, CLOUD_MODELS, latencies),
          onPick: (id) => {
            if (!isOrdering(id) || id === ordering) return
            void patch({ modelOrder: id })
          }
        },
        onPick: (name) => {
          const hosted = CLOUD_MODELS.find((m) => m.id === name)
          if (hosted && !usable(hosted.provider)) {
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
          /*
           * Picking the model already in use says nothing.
           *
           * The row carries a dot for the current one and is still
           * clickable, so choosing it is a confirmation rather than a
           * change - and announcing a change that did not happen is how
           * two identical lines end up in the transcript. The de-duplication
           * in `note` is the safety net; this is the cause.
           */
          if (name === current) {
            close()
            return
          }
          void patch({ model: name })
          void window.wumpy.assistant.status().then(setAssistant)
          chat.note(
            hosted
              ? `Now answering with **${hosted.label}**. ${hosted.blurb}`
              : `Now answering with \`${name}\`.`,
            false,
            'model'
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
          chat.note(
            `Searches will open in **${
              SEARCH_ENGINES[isSearchEngine(id) ? id : DEFAULT_ENGINE].label
            }**.`,
            false,
            'engine'
          )
          close()
        },
        items: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({
          id,
          title: e.label,
          meta: new URL(e.url).hostname,
          active: id === (settings?.searchEngine ?? DEFAULT_ENGINE)
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
        void window.wumpy.chats.delete(id).then(async () => {
          // Deleting the chat that is open only removed the file: the next
          // autosave wrote it straight back under the same id, so it vanished
          // from the list and quietly returned on the following message.
          if (id === chatId) newChat()
          /*
           * Close once there is nothing left to delete, rather than leaving
           * a list of nothing with a search box over it. The count comes
           * from the refresh, not from state, which has not re-rendered.
           */
          if ((await refreshChats()).length === 0) close()
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
        : 'Unpinned — will hide when it loses focus.',
      false,
      /* The same fact as the /pin command's note, so the two replace each
         other: pressing Ctrl+P four times is one statement, not four. */
      'pin'
    )
  }

  const liveKey = hotkey.intercepted ?? hotkey.active
  const hotkeyLabel = liveKey ? prettify(liveKey) : 'tray only'
  const compact = !isTall(dock)

  return (
    <div
      className={`panel dock-${dock} ${compact ? 'is-compact' : 'is-tall'}`}
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
        update={update}
        busy={streaming}
        onUpdate={() =>
          update?.stage === 'available'
            ? void runCommandRef.current({ kind: 'update', force: false }, '/update')
            : void restartRef.current(`to install Wumpy ${update?.next ?? 'update'}`)
        }
      />

      {picker ? (
        <Picker {...pickerProps(picker)} />
      ) : (
        <div className="scroll" ref={scroller} onScroll={onScroll} tabIndex={-1}>
          {/*
            tabIndex -1 above: somewhere for Ctrl+Tab to land when there is no
            button in the transcript at all, which is most conversations.
            Negative because it is a place you are PUT rather than a stop on
            the Tab route - and once there, the arrow keys scroll it with no
            handler of ours involved.
          */}
          {/*
            A long session is slow because every message is a live subtree,
            not because of anything the model is doing. Only the end of it is
            in the page; the rest is still in state and still sent. See
            transcript.ts.
          */}
          {folded && (
            <button type="button" className="earlier" onClick={revealMore}>
              {hidden} earlier message{hidden === 1 ? '' : 's'} hidden — show {REVEAL_STEP} more
            </button>
          )}
          {messages.length === 0 ? (
            <Empty
              hotkeyLabel={hotkeyLabel}
              online={assistant?.ready ?? false}
              model={model}
              compact={compact}
            />
          ) : (
            shown.map((m) => {
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
                  onCaptureScreen={canSeeScreen ? captureScreen : undefined}
                  onScreenCaptured={onScreenCaptured}
                  {...(canSeeScreen ? { onLook: lookAtPath, onLooked } : {})}
                  onDesktop={canDrive ? runDesktop : undefined}
                  onDesktopDone={onDesktopDone}
                  onOpenLink={canOpenLinks ? openLink : undefined}
                  onOpenSearch={openSearch}
                  onOpened={onOpened}
                  linkMode={fresh ? linkMode : 'manual'}
                  searchEngine={settings?.searchEngine ?? DEFAULT_ENGINE}
                  onCommand={runNamedCommand}
                  onAppCommand={runApprovedCommand}
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
            <div className={`turn-end is-${ended.tone}`} role="status" title={ended.detail || undefined}>
              {ended.tone !== 'done' && (
                <b className="turn-end-flag">
                  <i aria-hidden="true" />
                  {ended.label}
                </b>
              )}
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

      {/*
        The listening pill shows while it is ON, whatever it has heard -
        which used to be the one case it was hidden for.

        The gate was `words > 0`, so the pill appeared only once something
        had been transcribed. That inverted the reason the pill exists: the
        minutes when nothing is coming through are exactly the minutes worth
        seeing, and a session that never heard anything had no pill at all
        while quietly attaching an empty transcript to every turn. A
        finished transcript still needs words to be worth a chip; a live
        session does not.
      */}
      <StatusBar
        model={model}
        ready={assistant?.ready ?? false}
        streaming={streaming}
        stats={stats}
        usage={usage}
        pool={pool}
        compact={compact}
        approvalMode={settings?.approvalMode ?? 'manual'}
        listening={
          listening.session && (listening.on || wordCount(listening.session) > 0)
            ? {
                words: wordCount(listening.session),
                live: listening.on,
                level: listening.level,
                watching: listening.watching,
                seen: listening.session.seen?.length ?? 0
              }
            : null
        }
        onListening={() =>
          void runCommand(
            { kind: 'listen', what: listening.on ? 'stop' : 'notes', ask: '' },
            /* Not `/listen`: there is no such command. Nothing reads this
               for a 'listen' action anyway - it is the text a command
               echoes - but a string that looks like one is a thing somebody
               will copy out of the source and type. */
            'listen'
          )
        }
        onCycleApproval={() => void runCommand({ kind: 'approve', mode: 'cycle' }, '/approve')}
        reflect={settings?.reflect ?? false}
        onReflectOff={() => void runCommand({ kind: 'reflect', on: false }, '/reflect off')}
        stopAt={stopAt}
        onStopAtOff={() => {
          deadline.set(null)
          setStopAt(null)
          chatRef.current.note(DEADLINE_CLEARED_TEXT)
        }}
        onCompact={() => void compactHistory()}
        onQuota={() => void runCommand({ kind: 'usage', reset: false }, '/usage')}
      />

      <Toast message={toast} onDone={() => setToast(null)} />

      <VoiceTurnBar />
      {calibrating && (
        <VoiceCalibration
          onClose={(state) => {
            setCalibrating(false)
            if (state) chat.note(voiceprintNote(state, 'calibrate'), false, 'voiceprint')
          }}
        />
      )}

      <Composer
        onSend={onSend}
        onStop={stopAndMaybeEdit}
        streaming={streaming}
        activity={activity}
        focusToken={focusToken}
        tucked={tucked}
        canSeeMedia={seesMedia(model)}
        describedBy={eyeReady(model, keyStatus?.configured ?? [])?.label}
        onSay={say}
        prefill={prefill}
        queued={queued}
        onUnqueue={() => {
          /* Takes the oldest back into the box, leaving any others queued. */
          setPrefill(queued[0] ?? '')
          setQueued((rest) => rest.slice(1))
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
          <kbd>Ctrl+K</kbd> for everything it can do, <code>/shortcuts</code> for them.
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

/** How many positions two equal-length words differ in. */
function countDiff(a: string, b: string): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

function clockOf(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * Summary under a finished answer: how long it took and how fast it ran.
 *
 * THE TIME IS THE WHOLE TASK, not the last request of it.
 *
 * A turn ends whenever Wumpy has to go and do something - take a
 * screenshot, run a command, open a picture - and the hand-back that
 * follows is a new turn with a new clock. So an answer that took a minute
 * to arrive through three of those reported the last one, and "1.2s" sat
 * under something nobody waited 1.2 seconds for.
 *
 * When nothing interrupted, the two are the same number and this reads
 * exactly as it always did. When they differ, the legs are named - "14.2s
 * over 3" - because a total with no explanation invites the opposite
 * suspicion, that the model is slower than it is.
 */
/** How long "still going" holds after the work ends. See `ended` in App. */
const END_GRACE_MS = 1500

function endOfReplyLabel(stats: ChatStats): string {
  const parts: string[] = []
  const task = stats.lastTaskMs
  const turn = stats.lastTurnMs
  if (task !== null && turn !== null && task > turn + 50) {
    /* Legs rather than a precise count: what is known is how much time is
       unaccounted for by the last turn, and that it took at least two. */
    parts.push(`${clockOf(task)} total`, clockOf(turn))
  } else if (turn !== null) {
    parts.push(clockOf(turn))
  }
  if (stats.speed !== null) parts.push(`${stats.speed.toFixed(1)} tok/s`)
  if (stats.lastCompletionTokens !== null) parts.push(`${stats.lastCompletionTokens} tok`)
  return parts.length ? parts.join(' · ') : 'end of reply'
}

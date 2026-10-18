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
  WumpySettings,
  Attachment,
  DesktopResult
} from '@shared/types'
import { isTall } from '@shared/types'
import type { PoolView } from '@shared/pool'
import { looksLikeUrl, SEARCH_ENGINES, type LinkApproval } from '@shared/links'
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
import { CLOUD_MODELS, PROVIDERS, eyeReady, modelTag, rankedModels, seesMedia } from '@shared/cloud'
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
import { poolLines } from './quota'
import { probeLines } from '@shared/probe'
import { copyText } from './copy'
import { Toast } from './components/Toast'
import { forgetActions, record } from './ledger'
import { matchIntent } from './intents'
import { AUTO_RUN_LIMIT, autoRunEligible } from './autorun'
import { DOCK_CYCLE, Header } from './components/Header'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import logo from './assets/logo.png'
import { Picker, type PickerProps } from './components/Picker'
import { firstShown, foldsTranscript, hiddenCount, REVEAL_STEP } from './transcript'
import { activityFor } from '@shared/activity'

/** Mirrors the main process's accelerator formatting for display. */
function prettify(accelerator: string): string {
  return accelerator.replace(/Super|Meta|Cmd|CommandOrControl/g, 'Win').replace(/\+/g, ' + ')
}

const NEWLINE = String.fromCharCode(10)

export default function App(): React.JSX.Element {
  const chat = useChat()
  const { messages, streaming, streamingId, stats } = chat

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
    chat.setContext({ chatTitle })
  }, [chat, chatTitle])

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
  const retitleRef = useRef(retitle)
  retitleRef.current = retitle

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
          : namedControls(shot))
      ].join(String.fromCharCode(10)),
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

  const runDesktop = useCallback((body: string) => window.wumpy.desktop.run(body), [])

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
      ...(after ? namedControls(after) : [])
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
  const checkWrite = useCallback((path: string) => window.wumpy.files.check(path), [])

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
  const onWritten = useCallback((result: WriteResult) => {
    if (result.written) record('write', result.path)
    chatRef.current.notify(wroteLine(result))
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
    if (done) chatRef.current.note(roomNote(used, limit))
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
           * No confirmation. This is the same answer the user has given
           * three times about accept-all - they own the machine and would
           * rather have the thing happen than be asked - and unlike a
           * command on the filesystem, the cost of being wrong here is one
           * conversation. The chat is named in the confirmation so it is at
           * least obvious WHICH one went.
           */
          if (!action.pick) {
            const name = chatTitle ?? 'this chat'
            const id = chatId
            const saved = (await refreshChats()).some((c) => c.id === id)
            newChat()
            if (saved) await window.wumpy.chats.delete(id)
            await refreshChats()
            say(saved ? `Deleted "${name}".` : 'Started a new chat; there was nothing saved yet.')
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
        /*
         * One account or several, which Wumpy cannot work out and the user
         * knows for certain. It changes the pace between requests, how much
         * allowance the meter believes in, and whether one key's refusal
         * stands the others down with it.
         */
        case 'accounts': {
          const label = PROVIDERS[action.provider].label
          const held = keyStatus?.counts?.[action.provider] ?? 0
          const fixed = PROVIDERS[action.provider].quotaPerKey === true

          if (fixed) {
            chat.note(
              `Every ${label} key is its own project with its own allowance — ` +
                'that is how their free tier is metered, so there is nothing to tell me.'
            )
            return
          }

          const current = settings?.keyAccounts?.[action.provider] ?? 'shared'
          if (action.mode === null) {
            chat.note(
              current === 'separate'
                ? `Assuming your ${held} ${label} key(s) are on **separate accounts**, ` +
                    'so each has its own rate limit. Say `shared` if that is wrong.'
                : `Assuming all ${held} ${label} key(s) are on **one account**, so they ` +
                    'share one rate limit. If each is from its own account, say ' +
                    `\`/key ${action.provider} accounts separate\` — it is worth saying.`
            )
            return
          }

          await patch({
            keyAccounts: { ...(settings?.keyAccounts ?? {}), [action.provider]: action.mode }
          })
          chat.note(
            action.mode === 'separate'
              ? `Noted: ${held} ${label} key(s), one account each. Wumpy will now pace ` +
                  'them independently, count every account into the meter, and stop ' +
                  'standing one down because another was refused.'
              : `Noted: all ${held} ${label} key(s) on one account. They share a queue ` +
                  'and a ceiling, which is the cautious reading and the default.'
          )
          return
        }

        case 'models': {
          chat.note(
            `Asking all ${CLOUD_MODELS.length} models whether they answer — ` +
              'one small request each, so this costs a little quota and takes a moment.'
          )
          const results = await window.wumpy.models.probe()
          chat.note(probeLines(results, model).join(NEWLINE))
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
            return
          }

          /* Typed rather than picked, so there IS an answer owed - but
             "now" is a change, and nothing changed. */
          if (id === model) {
            chat.note(`Already answering with \`${id}\`.`)
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

          /*
           * Even with nothing spent, the pool is worth printing: "20 keys,
           * all ready, resets at 08:00" is the answer to "how much have I
           * got", and before this it took a 429 to find out.
           */
          const poolReport = report.pool ? poolLines(report.pool) : []

          if (!report.lines.length) {
            chat.note(
              [
                action.reset
                  ? 'Usage cleared.'
                  : `Nothing used yet today. Answering with \`${report.model}\`.`,
                ...(poolReport.length ? ['', ...poolReport] : [])
              ].join(NEWLINE)
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
              ...(poolReport.length ? ['', ...poolReport] : [])
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

          /*
           * Which keys are still good.
           *
           * Reported by POSITION, because that is what the main process
           * sends: a key never crosses that boundary, not even masked, so
           * "key 1, 2 and 3" is the most that can be said - and it is
           * enough, since /key google <the rest> replaces the list.
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
                  `or replace the whole list with \`/key ${provider} <key…>\`.`
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
        case 'setting': {
          /* The only one so far, and it says what it costs rather than just
             reporting a flag: the whole point of it is the number. */
          const next = action.on === 'toggle' ? !settings?.leanPrompt : action.on
          await patch({ leanPrompt: next })
          chat.note(
            next
              ? 'Short instructions on. About 2,500 fewer tokens every turn — the thirteen ' +
                  'rules measured to carry the benchmark are kept, the worked examples are not.'
              : 'Full instructions on. Every rule, every example, about 2,500 tokens more a turn.'
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
    (text: string, images?: Attachment[]) => {
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
    [chat, compactHistory, runCommand, settings, streaming, usage.used]
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
  }, [chat, close, newChat, retitle, runCommand, scrollBy, stepMessage, picker, streaming, stopAndMaybeEdit])

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
      /* A keyless provider is ready as soon as it is listed: Ollama runs on
         this machine and is authorised at the daemon, so "needs a key" would
         be advice nobody can follow and the model would never be pickable. */
      const usable = (p: (typeof CLOUD_MODELS)[number]['provider']): boolean =>
        PROVIDERS[p].keyless || (keyStatus?.configured.includes(p) ?? false)

      /*
       * Ordered by what each one scored, not by the order they were typed
       * into the catalogue, and badged with its place. The thing being
       * chosen between here IS how good they are, and that used to be a
       * clause halfway through the blurb.
       */
      const cloudItems = rankedModels()
        .slice()
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map(({ model: m, rank }) => {
          const ready = usable(m.provider)
          const tag = modelTag(m, rank)
          return {
            id: m.id,
            title: m.label,
            meta: `${PROVIDERS[m.provider].label}  ·  ${ready ? m.blurb : 'needs a key — /key ' + m.provider}`,
            ...(tag ? { tag } : {}),
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
        : 'Unpinned — will hide when it loses focus.'
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
      />

      {picker ? (
        <Picker {...pickerProps(picker)} />
      ) : (
        <div className="scroll" ref={scroller} onScroll={onScroll}>
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
                  onDesktop={canDrive ? runDesktop : undefined}
                  onDesktopDone={onDesktopDone}
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
        pool={pool}
        compact={compact}
        approvalMode={settings?.approvalMode ?? 'manual'}
        onCycleApproval={() => void runCommand({ kind: 'approve', mode: 'cycle' }, '/approve')}
        onCompact={() => void compactHistory()}
        onQuota={() => void runCommand({ kind: 'usage', reset: false }, '/usage')}
      />

      <Toast message={toast} onDone={() => setToast(null)} />

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

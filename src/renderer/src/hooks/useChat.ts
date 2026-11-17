import { useCallback, useEffect, useRef, useState } from 'react'
import { actionFacts } from '../ledger'
import type { Attachment, ChatMessage, LocalAsk, NoteTopic } from '@shared/types'
import { BAIL_WINDOW_MS, hasBlock, returnsThePrompt } from '../abort'
import { handsFree } from '../handsfree'
import {
  collapsed,
  repeatOf,
  repeatOfNote,
  restated,
  restatementOf,
  type ChipKind
} from '@shared/notify'

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
  /** Wall-clock duration of the last completed turn. */
  lastTurnMs: number | null
  /**
   * The whole interaction, not the last leg of it.
   *
   * A turn ends when a screenshot is taken, a command runs or a picture is
   * opened, and the hand-back that follows is a new turn with a new clock -
   * so "1.2s" under an answer that took most of a minute to arrive was
   * timing the last of four requests. True, and not the question anyone is
   * asking: the question is how long since they pressed send.
   *
   * Identical to lastTurnMs whenever nothing interrupted, which is most
   * turns, so the common case reads exactly as it did.
   */
  lastTaskMs: number | null
}

export interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  /**
   * The message currently being written, by id.
   *
   * Not "the last message": a command that runs while the answer is still
   * streaming appends its result after it, and the turn in flight stops being
   * last. Anything keyed on position then thinks the answer has finished.
   */
  streamingId: string | null
  stats: ChatStats
  /** False when a turn is already in flight and the message was not sent. */
  send(text: string, displayText?: string, images?: Attachment[], automatic?: boolean): boolean
  /** Live facts handed to the model each turn; set by the app. */
  setContext(ctx: { chatTitle: string | null }): void
  /** Messages as the model would see them, for size estimates and compaction. */
  history(): Array<{ role: string; content: string }>
  /**
   * Adds a local-only note (command output, errors) without calling the model.
   *
   * `topic` is for the notes that state what is true NOW - the mode, the
   * model, whether the panel is pinned. Two notes on one topic are one
   * statement changing its mind, so the second replaces the first rather
   * than being added under it. See restatementOf in shared/notify.ts.
   */
  note(content: string, error?: boolean, topic?: NoteTopic): void
  /**
   * A note meant to be rewritten later, returning the id to rewrite it by.
   *
   * For a report that goes out of date while it is on screen - `/log` and
   * the hourly ranking. Given a topic it replaces the last report on that
   * subject rather than adding a second copy of it, and hands back that
   * one's id so the subscription carries on rewriting the right message.
   */
  liveNote(content: string, topic?: NoteTopic): string
  /** Rewrites one local note in place. Ignores a message that has gone. */
  update(id: string, content: string): void
  /** Adds a line the model will see as context, shown as a chip. */
  notice(content: string): void
  /**
   * Says what Wumpy just did, in one line the model never reads.
   *
   * The same line arriving again with nothing but Wumpy's own turns in
   * between updates the one already there instead of adding another. See
   * shared/notify.ts for what "again" means and why.
   */
  notify(content: string): void
  /**
   * Something the user says while a turn is still running.
   *
   * It cannot change the answer being written - that is already in flight -
   * but it is in front of the model from the next turn on, which is what makes
   * it worth saying now rather than waiting for the model to finish.
   */
  aside(content: string): void
  /** Records which option was chosen for a message's question. */
  recordAnswer(messageId: string, option: string): void
  /** Asks the user something without involving a model. */
  /** Returns the question's message id, for whoever acts on the answer. */
  askLocal(
    question: string,
    options: string[],
    kind: LocalAsk['kind'],
    extra?: Pick<LocalAsk, 'values' | 'say' | 'spoken' | 'aliases' | 'unavailable'>
  ): string
  /**
   * Stops the answer. Returns the question to put back in the box when the
   * user bailed out before anything had happened, or null.
   */
  stop(): string | null
  clear(): void
  replace(messages: ChatMessage[]): void
}

export function useChat(): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [stats, setStats] = useState<ChatStats>({
    speed: null,
    loadMs: null,
    contextTokens: null,
    lastCompletionTokens: null,
    liveTokens: 0,
    elapsedMs: null,
    lastTurnMs: null,
    lastTaskMs: null
  })
  /** Wall clock for the turn in flight, so elapsed survives re-renders. */
  const startedAt = useRef<number | null>(null)
  /**
   * And the work done on the whole interaction, which outlives the turn.
   *
   * Reset only by a message the USER sent. An automatic hand-back - a
   * command's output, a screenshot, a file the model asked to open - is
   * the same piece of work continuing, and restarting the clock for it is
   * what made a long task report a short time.
   *
   * ACCUMULATED RATHER THAN WALL CLOCK, which matters in manual mode and
   * is the difference between a useful number and a flattering one. A
   * proposal sits on screen until it is pressed: timing from the first
   * message to the last would count however long someone spent deciding,
   * so a task they thought about over lunch would report as four hours of
   * work. Summing the turns measures what Wumpy actually spent, and on
   * accept-all - where nothing waits - the two are the same anyway.
   */
  const taskMsSoFar = useRef(0)

  /** Request currently streaming; also the key we match incoming deltas against. */
  const activeRequest = useRef<string | null>(null)
  /** Assistant message being filled by that request. */
  const activeMessage = useRef<string | null>(null)
  /** Facts about the app that the model cannot see for itself. */
  const context = useRef<{ chatTitle: string | null }>({ chatTitle: null })
  /** Mirrors `messages` so `send` can read history without a stale closure. */
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  const patchActive = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const target = activeMessage.current
    if (!target) return
    setMessages((prev) => prev.map((m) => (m.id === target ? patch(m) : m)))
  }, [])

  /**
   * Removes a reply that never said anything.
   *
   * An assistant message with nothing in it renders the thinking dots, and those
   * are a promise that something is coming. Cutting a turn off before the first
   * token left one in the transcript for good: a row of dots between two
   * questions, still pulsing, with nothing behind it. A model that finished
   * without producing a word left the same thing.
   *
   * Anything that did say something stays, however little: a short answer, a
   * scratchpad, an error. Deleting those would throw away what was written.
   */
  const dropIfEmpty = useCallback((id: string | null) => {
    if (!id) return
    setMessages((prev) =>
      prev.filter(
        (m) =>
          m.id !== id || m.content.trim() !== '' || Boolean(m.thinking?.trim()) || Boolean(m.error)
      )
    )
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
      /* Marked before the message stops being the active one. An answer that
         hit the cap has to say so: everything else about the end of a turn
         looks identical whether it finished or merely stopped. */
      if (d.cutOff) patchActive((m) => ({ ...m, cutOff: d.cutOff }))
      /* Added up before the state goes in, not inside the updater: an
         updater can be called twice for one event and the ref would count
         the turn twice. */
      const turnMs = startedAt.current ? Date.now() - startedAt.current : 0
      taskMsSoFar.current += turnMs
      const taskMs = taskMsSoFar.current
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
        elapsedMs: null,
        // Wall clock, not the model's own timings: this is what the user waited.
        lastTurnMs: turnMs || s.lastTurnMs,
        lastTaskMs: taskMs || s.lastTaskMs
      }))
      startedAt.current = null
      activeRequest.current = null
      dropIfEmpty(activeMessage.current)
      activeMessage.current = null
      setStreamingId(null)
      setStreaming(false)
    })

    const offError = window.wumpy.chat.onError((d) => {
      if (d.requestId !== activeRequest.current) return
      patchActive((m) => ({ ...m, error: d.message }))
      startedAt.current = null
      activeRequest.current = null
      activeMessage.current = null
      setStats((s) => ({ ...s, liveTokens: 0, elapsedMs: null }))
      setStreamingId(null)
      setStreaming(false)
    })

    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [patchActive])

  const send = useCallback(
    (
      text: string,
      displayText?: string,
      images?: Attachment[],
      automatic = false
    ): boolean => {
    const trimmed = text.trim()
    // Refused rather than queued: the caller knows what to do with the message
    // it could not send, and silently dropping a command's output left the
    // model answering from a conversation that was missing a step.
    // An image on its own is a message: "what is this" is implied by having
    // attached it, so an empty line with a picture still goes.
    if ((!trimmed && !images?.length) || activeRequest.current) return false

    const userMessage: ChatMessage = {
      id: nextId(),
      role: 'user',
      // A command such as /plan sends a wrapped prompt but shows what was typed.
      content: displayText ?? trimmed,
      createdAt: Date.now(),
      ...(images?.length ? { images } : {}),
      ...(automatic ? { automatic: true } : {}),
      ...(handsFree() && !automatic ? { spoken: true } : {})
    }
    const assistantMessage: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now()
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
      /**
       * Images go with the turn they were attached to, not just the newest
       * one, so a follow-up question about a screenshot two turns back still
       * has the screenshot. The main process turns them into content parts;
       * here they are only carried.
       */
      if (m.images?.length) return { role: m.role, content: m.content, images: m.images }
      return { role: m.role, content: m.content }
    })

    const requestId = nextId()
    activeRequest.current = requestId
    activeMessage.current = assistantMessage.id

    startedAt.current = Date.now()
    /* Only a message the user wrote starts a new task; a hand-back adds to
       the one already running. */
    if (!automatic) taskMsSoFar.current = 0
    setMessages((prev) => [...prev, userMessage, assistantMessage])
    setStreamingId(assistantMessage.id)
    setStreaming(true)
    setStats((s) => ({ ...s, speed: null, liveTokens: 0, elapsedMs: 0 }))

    void window.wumpy.chat.send({
      requestId,
      messages: history,
      context: {
        chatTitle: context.current.chatTitle,
        messageCount: history.length,
        actions: actionFacts(),
        handsFree: handsFree()
      }
    })
    return true
    },
    []
  )

  useEffect(() => {
    if (!streaming) return
    // 250ms still reads as a live counter at tenth-of-a-second precision, and
    // is a quarter of the wake-ups during the one period that matters.
    const timer = setInterval(() => {
      if (startedAt.current === null) return
      /* The task's total, so the bar counts on through a screenshot instead
         of dropping back to zero and starting again. */
      setStats((s) => ({
        ...s,
        elapsedMs: taskMsSoFar.current + (Date.now() - (startedAt.current ?? Date.now()))
      }))
    }, 250)
    return () => clearInterval(timer)
  }, [streaming])

  const history = useCallback(
    () =>
      messagesRef.current
        .filter((m) => !m.error && !m.local)
        .map((m) => ({ role: m.notice ? 'system' : (m.role as string), content: m.content })),
    []
  )

  const note = useCallback((content: string, error = false, topic?: NoteTopic) => {
    setMessages((prev) => {
      /*
       * A statement about something already stated replaces it.
       *
       * Not the same thing as the repeat below, which is the same words
       * twice. This is the same SUBJECT twice in different words - three
       * presses of Shift+Tab saying "Manual", then "Auto", then "Accept
       * all", all about one setting and the first two wrong by the time
       * they are read. See restatementOf for which earlier note counts.
       */
      if (topic && !error) {
        const earlier = restatementOf(prev, topic)
        if (earlier) return restated(prev, earlier, content, Date.now())
      }
      /*
       * The same note twice running is said once.
       *
       * Reported with a screenshot of two identical "Now answering with
       * DeepSeek V4.1 Flash" lines: "I said repeating notifications spam
       * the chat". The chips learned this and notes were excluded, which
       * was the bug rather than the design.
       *
       * No count is shown, unlike a chip. A chip is a receipt for an action
       * that really did happen twice; a note states what is true now, and
       * "Now answering with X ×2" would be describing the state as though
       * it had doubled. It moves to the end instead, so it is still the
       * last thing said. Decided inside the updater, so a StrictMode double
       * invoke cannot count the same note twice.
       */
      const again = error ? null : repeatOfNote(prev, content)
      if (again) return collapsed(prev, again, Date.now())
      return [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          content: error ? '' : content,
          error: error ? content : undefined,
          createdAt: Date.now(),
          local: true,
          topic
        }
      ]
    })
  }, [])

  /**
   * A note that is going to be rewritten, and the id to rewrite it by.
   *
   * `/log` asked for this: "when my logs is displayed, also make it auto
   * update... when it rechecks the models, also automatically add that in,
   * especially while I'm still looking at the logs". A report that is a
   * snapshot of a file that changes is out of date the moment anything
   * happens, and the thing it reports on - the hourly ranking - happens
   * while nobody is typing.
   *
   * Deliberately NOT `note`, which folds an identical note into the one
   * before it and moves it to the end. That is right for "now answering
   * with X" and wrong here twice over: the id would be the older message's,
   * and the decision is made inside the state updater where the caller
   * cannot see it. This one always appends, so the id it returns is the id
   * of the thing it just made.
   */
  const liveNote = useCallback((content: string, topic?: NoteTopic): string => {
    /**
     * Decided out here rather than inside the updater, unlike `note`.
     *
     * The caller needs the id NOW - it is what the subscription rewrites the
     * report by - and a functional update does not run until React gets
     * round to rendering, so nothing it decides can be returned from this
     * call. messagesRef is the same list the updater will see, one render
     * behind at worst, and the fallback below covers that worst.
     */
    const earlier = topic ? restatementOf(messagesRef.current, topic) : null
    const id = earlier ?? nextId()
    setMessages((prev) =>
      earlier && prev.some((m) => m.id === earlier)
        ? restated(prev, earlier, content, Date.now())
        : [...prev, { id, role: 'assistant', content, createdAt: Date.now(), local: true, topic }]
    )
    return id
  }, [])

  /**
   * Rewrites one message that is already on screen.
   *
   * Only ever used on a local note the app itself wrote - nothing the user
   * said or the model answered is rewritten, which is the rule the whole
   * transcript rests on. A message that has gone (a new chat, a reopened
   * one) is left alone rather than resurrected.
   */
  const update = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.some((m) => m.id === id && m.local)
        ? prev.map((m) => (m.id === id ? { ...m, content } : m))
        : prev
    )
  }, [])

  const setContext = useCallback((ctx: { chatTitle: string | null }) => {
    context.current = ctx
  }, [])

  const askLocal = useCallback(
    (
      question: string,
      options: string[],
      kind: LocalAsk['kind'],
      extra?: Pick<LocalAsk, 'values' | 'say' | 'spoken' | 'aliases' | 'unavailable'>
    ): string => {
      const id = nextId()
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          local: true,
          localAsk: { question, options, kind, ...(extra ?? {}) }
        }
      ])
      return id
    },
    []
  )

  const recordAnswer = useCallback((messageId: string, option: string) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, answered: option } : m)))
  }, [])

  /**
   * Adds a chip, or counts up the one it repeats.
   *
   * Decided inside the state updater on purpose: `prev` is the only version
   * of the transcript that cannot be stale, and two cards finishing in the
   * same tick would otherwise both read it as it was before either of them
   * landed - which is how the unattended-run de-duplication managed to be
   * there and never see itself. The decision is a pure function of `prev`,
   * so StrictMode replaying the updater reaches the same answer.
   */
  const chip = useCallback((kind: ChipKind, fresh: ChatMessage) => {
    setMessages((prev) => {
      const again = repeatOf(prev, kind, fresh.content)
      return again ? collapsed(prev, again, fresh.createdAt) : [...prev, fresh]
    })
  }, [])

  const notice = useCallback(
    (content: string) => {
      chip('notice', {
        id: nextId(),
        role: 'system',
        content,
        createdAt: Date.now(),
        notice: true
      })
    },
    [chip]
  )

  /**
   * Local, so it never reaches the model.
   *
   * What it is a receipt for went to the model as its own hand-back, and
   * saying it twice would cost the window a line per command for nothing.
   * The model is told what Wumpy did by the ledger, in the facts block.
   */
  const notify = useCallback(
    (content: string) => {
      chip('notification', {
        id: nextId(),
        role: 'system',
        content,
        createdAt: Date.now(),
        local: true,
        notification: true
      })
    },
    [chip]
  )

  const aside = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'system',
        content: `The user added, while you were still answering: ${content}`,
        createdAt: Date.now(),
        notice: true,
        aside: true
      }
    ])
  }, [])

  /**
   * Stop, and say whether the question is worth handing back.
   *
   * Returns the text the user typed when they bailed out early enough that
   * nothing had happened yet - the caller puts it back in the box. In that
   * case the dead exchange is removed as well: a question that was withdrawn
   * a second after being asked is not part of the conversation, and leaving
   * it in means the model reads it again on the next turn and the user has
   * the same line twice on screen.
   */
  const stop = useCallback((): string | null => {
    if (!activeRequest.current) return null
    window.wumpy.chat.abort(activeRequest.current)
    activeRequest.current = null

    const answerId = activeMessage.current
    const answer = messagesRef.current.find((m) => m.id === answerId)
    const early = returnsThePrompt({
      elapsedMs: startedAt.current ? Date.now() - startedAt.current : BAIL_WINDOW_MS,
      outputChars: (answer?.content ?? '').trim().length,
      startedBlock: hasBlock(answer?.content ?? '')
    })

    /* The question that produced it: the user turn immediately before. */
    const at = messagesRef.current.findIndex((m) => m.id === answerId)
    const asked = at > 0 ? messagesRef.current[at - 1] : null
    const giveBack = early && asked?.role === 'user' && !asked.images?.length ? asked.content : null

    if (giveBack !== null) {
      const askedId = asked!.id
      setMessages((prev) => prev.filter((m) => m.id !== askedId && m.id !== answerId))
    } else {
      dropIfEmpty(answerId)
    }

    activeMessage.current = null
    startedAt.current = null
    setStats((s) => ({ ...s, liveTokens: 0, elapsedMs: null }))
    setStreamingId(null)
    setStreaming(false)
    return giveBack
  }, [])

  const clear = useCallback(() => {
    stop()
    /* Same reason as replace(): /new followed by a send must not carry the
       old conversation into the first turn of the new one. */
    messagesRef.current = []
    setMessages([])
    setStats({
      speed: null,
      loadMs: null,
      contextTokens: null,
      lastCompletionTokens: null,
      liveTokens: 0,
      elapsedMs: null,
      lastTurnMs: null,
      lastTaskMs: null
    })
  }, [stop])

  const replace = useCallback(
    (next: ChatMessage[]) => {
      stop()
      /*
       * The mirror is updated here as well as during the render, because the
       * caller's next line is usually a send.
       *
       * `await compactHistory(); chat.send(text)` runs both halves in one
       * microtask, and React's re-render is not one of the things that
       * happens in between - so without this the send that a compaction was
       * performed FOR still built its history from the conversation as it
       * was before the summary. The whole point of compacting before a send
       * was lost in silence, and the same would have been true of every
       * automatic hand-back.
       */
      messagesRef.current = next
      setMessages(next)
      // The counted context belonged to the old conversation; fall back to the
      // estimate until the next turn reports real numbers.
      setStats((s) => ({ ...s, contextTokens: null }))
    },
    [stop]
  )

  return {
    messages,
    streaming,
    streamingId,
    stats,
    send,
    setContext,
    history,
    note,
    liveNote,
    update,
    notice,
    notify,
    aside,
    askLocal,
    recordAnswer,
    stop,
    clear,
    replace
  }
}

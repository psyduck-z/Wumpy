import { useEffect, useMemo, useRef, useState } from 'react'
import { allCommands, completions, type CommandSpec } from '../commands'
import { CommandPalette } from './CommandPalette'
import { useInputHistory } from '../hooks/useInputHistory'
import { insistFocus } from '../focus'
import { caretRows } from '../caret'
import { adoptsKeystroke } from '../keyboard'
import { useDictation } from '../hooks/useDictation'
import { BRIDGE_MS, HOLD_MS, HoldToTalk, isPlainSpace, type HoldAction } from '../holdtotalk'
import { Mic } from './Mic'
import { filesIn, readAnyFile, TOKENS_PER_SECOND } from '../media'
import { attachmentTokens, sendsBytes, sizeLabel } from '@shared/attach'
import type { Attachment } from '@shared/types'
import { expandPastes, foldsPaste, pasteMarker, summarise } from '@shared/bulk'
import type { Activity } from '@shared/activity'

/** m:ss, for the length of a clip. */
function clockOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function Composer({
  onSend,
  onStop,
  streaming,
  activity = null,
  queued = [],
  onUnqueue,
  focusToken,
  tucked = false,
  prefill,
  placeholder,
  canSeeMedia = false,
  describedBy,
  onSay
}: {
  onSend(text: string, images?: Attachment[]): void
  onStop(): void
  streaming: boolean
  /** What the model is doing right now, or null. Only while streaming. */
  activity?: Activity | null
  /** Shown as a chip under the box: typed while busy, sent when the turn ends. */
  /** Lines typed while an answer was running, oldest first. */
  queued?: string[]
  onUnqueue?(): void
  /** Bumped whenever the panel is shown, so the caret lands in the box. */
  focusToken: number
  /**
   * The panel is in the tray.
   *
   * Only used to keep quiet about the keyboard: a window nobody has summoned
   * has no business reporting that it was not given focus, and used to do so
   * on every start. See IPC.panelTucked for why the page cannot work this
   * out for itself.
   */
  tucked?: boolean
  /**
   * Text to drop into the box, with a token so the same text twice still
   * lands. Used by the command menu for commands that take an argument.
   */
  prefill?: { text: string; token: number }
  placeholder: string
  /**
   * Whether the model answering can look at a picture or a clip.
   *
   * Attaching one to a model that cannot see is not a smaller version of the
   * feature, it is a request that silently loses half of itself - so the
   * paste is refused with a reason instead.
   */
  canSeeMedia?: boolean
  /**
   * The model that will read an image for this one, when it cannot.
   *
   * Named rather than a boolean, because what happens to the picture is
   * worth saying out loud: it goes to a different model, and what comes
   * back to the one answering is that model's description. Undefined when
   * there is no such model to borrow - then the refusal above stands.
   */
  describedBy?: string
  /** Said in a line that fades, for things that are not part of the chat. */
  onSay?(text: string): void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const history = useInputHistory()

  /* ------------------------------------------------------------- images */

  /**
   * Pictures waiting to go with the next message.
   *
   * Pasted, dropped or picked. They are shrunk on the way in rather than on
   * the way out - see images.ts - because the thumbnail, the wire and the
   * saved chat all want the same bytes, and a 2560-wide screenshot is not
   * worth keeping three versions of.
   */
  const [images, setImages] = useState<Attachment[]>([])
  /**
   * Text pasted in whole, folded to a marker in the box.
   *
   * Parallel to `images`: the real payload lives here and the composer holds
   * a short stand-in, which is substituted back on the way out.
   */
  const [pastes, setPastes] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * Takes any file at all.
   *
   * The media check moved INSIDE the loop and onto the attachment rather than
   * the model: a text file is characters and reaches a model that cannot see,
   * so refusing the whole drop because the model has no vision would have
   * refused the one kind of file that always works. Only an attachment whose
   * bytes have to go up needs eyes at the other end.
   */
  const attach = async (files: File[]): Promise<void> => {
    if (!files.length) return
    let refusedForVision = 0
    for (const file of files) {
      try {
        const attachment = await readAnyFile(file)
        /*
         * An image is accepted when something can read it - this model, or
         * the one it borrows eyes from. A clip, a sound or a PDF still needs
         * the model itself, because the eye is sent one still image and
         * cannot watch or listen.
         */
        const readable = canSeeMedia || (attachment.kind === 'image' && Boolean(describedBy))
        if (sendsBytes(attachment.kind) && !readable) {
          refusedForVision++
          continue
        }
        setImages((list) => [...list, attachment])
      } catch (err) {
        onSay?.((err as Error)?.message ?? `Could not read ${file.name}.`)
      }
    }
    if (refusedForVision > 0) {
      onSay?.(
        refusedForVision === 1
          ? describedBy
            ? `This model cannot read clips, sound or PDFs — only images, which ${describedBy} reads for it. Switch with /model.`
            : 'This model cannot read images, sound or PDFs. Switch with /model, or attach a text file.'
          : `${refusedForVision} files need a model that can see them. Switch with /model.`
      )
    }
    ref.current?.focus({ preventScroll: true })
  }

  const drop = (e: React.DragEvent): void => {
    const files = filesIn(e.dataTransfer?.files)
    // Only swallow the event when there was actually a file in it; a drag of
    // selected text should land wherever it would have landed.
    if (!files.length) return
    e.preventDefault()
    setDragging(false)
    void attach(files)
  }

  /** Puts a recalled line in the box with the caret at the end of it. */
  const recall = (text: string): void => {
    setValue(text)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }

  /**
   * Drops dictated text in at the caret.
   *
   * Appended rather than replacing, so speech and typing mix: half a sentence
   * typed and the rest spoken ends up as one sentence, and dictating twice adds
   * to what is there instead of throwing the first attempt away.
   */
  const insert = (text: string): void => {
    const el = ref.current
    setValue((current) => {
      const at = el ? el.selectionStart : current.length
      const before = current.slice(0, at)
      const after = current.slice(at)
      const gap = before && !/\s$/.test(before) ? ' ' : ''
      const next = before + gap + text + after
      requestAnimationFrame(() => {
        if (!el) return
        el.focus()
        const caret = (before + gap + text).length
        el.selectionStart = el.selectionEnd = caret
      })
      return next
    })
  }

  // The command names go along so that "slash also" can become "/also"; they are
  // read from the real list, so a command added later is dictatable at once.
  const commandNames = useMemo(() => allCommands().map((c) => c.name), [])
  const dictation = useDictation(insert, commandNames)

  // Ctrl+M starts and stops it. On the window rather than the box, because the
  // caret may be in a picker when the thought arrives.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        dictation.toggle()
        return
      }
      // Esc abandons a recording rather than closing the panel, but only while
      // one is running - otherwise Esc keeps meaning what it meant.
      if (e.key === 'Escape' && dictation.state === 'recording') {
        e.stopPropagation()
        dictation.cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dictation])

  /* ----------------------------------------------- hold the spacebar to talk */

  /**
   * The machine lives in a ref and the clock lives here.
   *
   * The decisions are all in HoldToTalk, which knows nothing about React and is
   * tested on its own; this is the timer, the key events and putting the text
   * back. The timer is scheduled a frame past the delay because setTimeout is
   * allowed to fire a touch early, and a tick that arrives early is a tick that
   * decides the key was not held long enough.
   */
  const hold = useRef(new HoldToTalk())
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopTimer = (): void => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current)
    settleTimer.current = null
    if (holdTimer.current === null) return
    clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  /**
   * What the spacebar did, for wumpy.log when a hold comes to nothing.
   *
   * "Holding the spacebar does not work" came back twice with nothing in the
   * log to say why: the machine never got as far as starting, so nothing it
   * logged was reached. This keeps the key events of one press - when each
   * came, and what it said it was - and writes them out only when the key was
   * held long enough to have meant "listen" and yet nothing listened.
   */
  const trace = useRef<{ from: number; events: string[]; listened: boolean } | null>(null)
  const traceKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, type: 'd' | 'u'): void => {
    const now = performance.now()
    if (type === 'd' && (!trace.current || hold.current.state === 'idle')) {
      trace.current = { from: now, events: [], listened: false }
    }
    const t = trace.current
    if (!t || t.events.length >= 24) return
    const odd = e.key === ' ' && e.code === 'Space' ? '' : `[${e.key}/${e.code}]`
    t.events.push(`${type}${e.repeat ? 'r' : ''}${Math.round(now - t.from)}${odd}`)
  }
  const traceEnd = (): void => {
    const t = trace.current
    trace.current = null
    if (!t || t.listened) return
    const held = performance.now() - t.from
    if (held < HOLD_MS) return
    window.wumpy.voice.log(
      `dictation: Space held ${Math.round(held)}ms but recording never started - keys: ${t.events.join(' ')}`
    )
  }

  /* And the one way the trace cannot catch: an input method that takes the
     key and hands the page only the space it typed, with no key event at all.
     Then nothing above runs, and this is the only sign of it. Once a run. */
  const lastSpaceKey = useRef(0)
  const toldNoKey = useRef(false)
  const spaceWithoutKey = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    if (!dictation.enabled || toldNoKey.current) return
    const typed = (e.nativeEvent as InputEvent).data
    if (typed !== ' ' || performance.now() - lastSpaceKey.current < 250) return
    toldNoKey.current = true
    window.wumpy.voice.log('dictation: a space was typed with no Space key event - an input method is keeping the key from the app')
  }

  const applyHold = (action: HoldAction, e?: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (action.swallow) e?.preventDefault()

    if (action.kind === 'arm') {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current)
      if (settleTimer.current !== null) clearTimeout(settleTimer.current)
      settleTimer.current = null
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null
        applyHold(hold.current.tick(performance.now()))
      }, action.wait + 16)
      return
    }

    if (action.kind === 'wait') {
      // The hold timer keeps running: if this turns out to be a repeat, the
      // press goes on, and if the timer fired meanwhile the press re-arms it.
      if (settleTimer.current !== null) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null
        applyHold(hold.current.settle(performance.now()))
      }, BRIDGE_MS + 8)
      return
    }

    if (action.kind === 'listen') {
      // Take the spaces back out. Everything the auto-repeat typed while the
      // delay ran goes with them, because this is the text as it was before the
      // key went down at all.
      const { value: text, caret } = action.restore
      setValue(text)
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.selectionStart = el.selectionEnd = caret
      })
      if (trace.current) trace.current.listened = true
      dictation.beginHold()
      return
    }

    if (action.kind === 'send') {
      stopTimer()
      traceEnd()
      dictation.finish()
      return
    }

    if (action.kind === 'cancel') {
      stopTimer()
      traceEnd()
      dictation.cancel()
    }
  }

  // A press whose release lands somewhere else would otherwise leave the machine
  // armed, and the next space would read as the end of a hold nobody is doing.
  const abandonHold = (): void => {
    stopTimer()
    applyHold(hold.current.abort())
  }

  useEffect(() => stopTimer, [])

  // Only offer the palette while the command name is still being typed; once
  // there is a space the user has moved on to the argument.
  const palette = useMemo(() => {
    if (!value.startsWith('/') || /\s/.test(value)) return [] as CommandSpec[]
    return completions(value)
  }, [value])

  useEffect(() => setSelected(0), [value])

  /**
   * Put the caret in the box whenever the panel is shown.
   *
   * Once is not enough, and twice was not either.
   *
   * The hotkey arrives in a background hook, so Windows hands the foreground
   * over asynchronously and the show message can reach the page before the
   * window actually holds it - a focus() made in that gap is silently
   * dropped. That was known, and the fix was one retry on the next animation
   * frame. One frame is 16ms against a handover that routinely takes 50-250ms,
   * so the retry landed in the same gap and the bug survived its own fix.
   *
   * insistFocus keeps going until document.hasFocus() is true and the caret
   * is actually here, or until it runs out of patience. See focus.ts.
   */
  useEffect(() => {
    // A picker focuses its own filter, and reopening the panel over one
    // should leave the user in the list they were choosing from.
    return insistFocus(
      () => ref.current,
      () => Boolean(document.querySelector('.picker')),
      // Half a second of trying and the window still has not been given the
      // keyboard. Only the main process can take it by force from here.
      () => window.wumpy.panel.requestFocus(),
      /*
       * Unless the panel is in the tray, in which case nobody asked for the
       * keyboard and there is nothing to report. Still tried while tucked -
       * focusing early is what makes the first keystroke after a summon
       * land - just not complained about.
       */
      () => tucked
    )
  }, [focusToken, tucked])

  /**
   * Two ways the caret gets back to the box without being asked.
   *
   * insistFocus above handles the panel being shown. Neither of these is
   * about that moment: they are about the caret going missing later, during
   * use, which is what "it STILL does not auto-focus" has been describing.
   *
   * The first is a cause. A card's Run button holds the caret, the command
   * runs, the button unmounts - and the browser does not hand focus to
   * anything, it drops it on document.body. Nothing in the app was watching
   * for that, and nothing refocuses on it, because the window never lost
   * focus so no focus event fires. Typing then goes nowhere.
   *
   * The second is the backstop for every cause not yet found. If a
   * printable key arrives and the caret is nowhere useful, the box takes
   * it - so the keystroke appears instead of vanishing, whatever went
   * wrong upstream.
   */
  useEffect(() => {
    const pickerOpen = (): boolean => Boolean(document.querySelector('.picker'))

    /**
     * Only when the element that had the caret was REMOVED.
     *
     * Not when the user clicks away, which is a decision they are allowed
     * to make, and not when focus moves on to something else - relatedTarget
     * says which. Narrow on purpose: a version that refocused on every
     * focusout would fight anyone trying to select output text with the
     * mouse.
     */
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget) return
      const left = e.target as Node | null
      if (!left || document.contains(left)) return
      if (pickerOpen()) return
      queueMicrotask(() => {
        if (document.activeElement && document.activeElement !== document.body) return
        if (pickerOpen()) return
        ref.current?.focus({ preventScroll: true })
      })
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const el = ref.current
      if (!el) return
      const what = adoptsKeystroke({
        key: e.key,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        target: e.target,
        composerHasFocus: document.activeElement === el,
        pickerOpen: pickerOpen(),
        isComposing: e.isComposing
      })
      if (what === 'ignore') return
      // The character is placed by hand rather than left to the browser:
      // whether a focus() made during keydown catches that same keystroke
      // is not something to depend on.
      e.preventDefault()
      el.focus({ preventScroll: true })
      if (what === 'insert') setValue((v) => v + e.key)
    }

    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  useEffect(() => {
    if (!prefill || prefill.token === 0) return
    setValue(prefill.text)
    const el = ref.current
    if (!el) return
    el.focus()
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = el.value.length
    })
    // Only the token: the same command twice must still fill the box.
  }, [prefill?.token])

  // Grow with the content up to a ceiling, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [value])

  const submit = (): void => {
    // An image on its own is a message. "What is this?" is implied by having
    // put it there, and making someone type a word first is a toll.
    if (!value.trim() && images.length === 0) return
    // Sending while busy used to do nothing at all: the keystroke vanished and
    // the box kept the text, with no sign that anything had happened. The app
    // decides what to do with it - queue it, or take it as an aside.
    history.push(value)
    /**
     * The markers are what was edited; the model gets what was pasted.
     *
     * History keeps the folded form, so pressing up gives back the short
     * line the user was looking at rather than six hundred lines of log.
     */
    onSend(expandPastes(value, pastes), images.length ? images : undefined)
    setValue('')
    setImages([])
    setPastes([])
  }

  const accept = (spec: CommandSpec): void => {
    // Commands that take an argument keep the caret going; the rest can run.
    setValue(spec.arg ? `/${spec.name} ` : `/${spec.name}`)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /**
     * The spacebar, before anything else looks at it.
     *
     * Only when voice input has been turned on with /voice: otherwise the most
     * pressed key on the keyboard behaves exactly as it always did, which is the
     * point of the switch. A space pressed and released is still a space even
     * when it is on - nothing happens until half a second of holding.
     */
    if (e.key === ' ' || e.code === 'Space') lastSpaceKey.current = performance.now()
    if (dictation.enabled && isPlainSpace(e)) {
      traceKey(e, 'd')
      const el = e.currentTarget
      applyHold(
        hold.current.down(performance.now(), { value: el.value, caret: el.selectionStart }),
        e
      )
      if (hold.current.state !== 'idle') return
    }

    if (palette.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i + 1) % palette.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i - 1 + palette.length) % palette.length)
        return
      }
      // Shift+Tab is left alone: it cycles approval mode, and `e.key` is 'Tab'
      // for both, so without this the palette swallowed it. Ctrl+Tab the
      // same - it moves between the parts of the panel, and a half-typed
      // command in the box must not be a place that key stops working.
      if ((e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) || (e.key === 'Enter' && !e.shiftKey)) {
        const spec = palette[selected]
        if (spec) {
          e.preventDefault()
          /**
           * Tab completes, Enter runs. The way a shell does it.
           *
           * Enter used to complete too, for anything that took an argument
           * at all — so `/model` became `/model ` and sat there waiting for
           * a name, and you pressed Enter a second time to get the picker
           * you wanted the first time. Reported as exactly that. Only the
           * three commands that are useless bare still ask for the
           * argument first.
           */
          if (e.key === 'Tab' || spec.argRequired) {
            accept(spec)
          } else {
            history.push(`/${spec.name}`)
            onSend(`/${spec.name}`)
            setValue('')
          }
          return
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }

    /*
     * History, once the palette has had its say. Only from the edge of the
     * text, so arrowing around a draft still moves the caret: Up on the
     * first ROW, Down on the last.
     *
     * Rows, not lines. This used to look for a newline before the caret,
     * which finds the first LOGICAL line - and in a 440px composer a
     * message of fifty characters already wraps across three rows with no
     * newline in it anywhere. So the caret was reported as being on the
     * first line while sitting on the third row: every Up recalled an older
     * entry instead of moving, and a recalled message could not be edited
     * from the top at all. Down had the same fault at the other end, which
     * is why it looked as though it did not navigate.
     */
    const el = e.currentTarget
    const rows = caretRows(el)
    if (e.key === 'ArrowUp' && !e.shiftKey && rows.first) {
      const prev = history.older(value)
      if (prev !== null) {
        e.preventDefault()
        recall(prev)
      }
      return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && rows.last) {
      const next = history.newer()
      if (next !== null) {
        e.preventDefault()
        recall(next)
      }
    }
  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'is-dropping' : ''}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the wrapper, not when it
        // crosses from the wrapper onto the textarea inside it.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDragging(false)
      }}
      onDrop={drop}
    >
      <CommandPalette items={palette} selected={selected} onPick={accept} />

      {images.length > 0 && (
        <div className="attachments">
          {images.map((img, i) => (
            <div className={`attachment is-${img.kind}`} key={`${img.bytes}:${i}`}>
              {img.kind === 'video' ? (
                // Muted, no controls: it is a thumbnail, not a player. The
                // first frame is what tells you which clip this is.
                <video src={img.dataUrl} muted preload="metadata" />
              ) : img.kind === 'image' ? (
                <img src={img.dataUrl} alt={img.name ?? 'Pasted image'} />
              ) : (
                /*
                 * No pixels, so no thumbnail: the name IS the thumbnail.
                 *
                 * The extension gets its own line because at this size it is
                 * the only part of "quarterly-report-final-v3.csv" that can be
                 * read at a glance, and a strikethrough says the file is
                 * attached but its contents are not being sent.
                 */
                <span
                  className={`attachment-file${img.kind === 'opaque' ? ' is-unread' : ''}`}
                  title={
                    img.kind === 'opaque'
                      ? `${img.name ?? 'file'} — attached, but this format cannot be read. The model is told it exists.`
                      : `${img.name ?? 'file'} — ${(img.chars ?? 0).toLocaleString()} characters${
                          img.truncated ? `, first ${(img.text?.length ?? 0).toLocaleString()} being sent` : ''
                        }`
                  }
                >
                  <span className="attachment-ext">
                    {(/\.([a-z0-9]+)$/i.exec(img.name ?? '')?.[1] ?? '?').toUpperCase().slice(0, 4)}
                  </span>
                  <span className="attachment-name">{img.name ?? 'file'}</span>
                </span>
              )}
              <button
                type="button"
                className="attachment-x"
                title="Remove"
                onClick={() => setImages((list) => list.filter((_, n) => n !== i))}
              >
                &#215;
              </button>
              {/* Length rather than size for a clip: seconds are what it
                  costs. About 105 tokens each, measured, so a minute is six
                  thousand and that is worth knowing before sending it. */}
              {/* What it costs, in whichever unit is the honest one: seconds
                  for a clip, characters for a file, bytes for a picture. A
                  trimmed file says so here rather than only in the tooltip. */}
              <span className="attachment-size">
                {img.kind === 'video' && img.seconds
                  ? `${clockOf(img.seconds)} · ~${Math.round((img.seconds * TOKENS_PER_SECOND) / 100) / 10}k`
                  : img.kind === 'text'
                    ? `${sizeLabel(img.bytes)} · ~${Math.round(attachmentTokens(img) / 100) / 10}k${img.truncated ? ' · part' : ''}`
                    : img.kind === 'opaque'
                      ? `${sizeLabel(img.bytes)} · not read`
                      : `${sizeLabel(img.bytes)}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/*
        What a fold actually contains, so "[pasted #1]" is not a mystery.
        Clicking one unfolds it back into the box, for the times the paste
        was short enough to want to edit after all.
      */}
      {pastes.some(Boolean) && (
        <div className="pastes">
          {pastes.map((body, i) =>
            body ? (
              <button
                key={i}
                type="button"
                className="paste-chip"
                title="Click to unfold this back into the box"
                onClick={() => {
                  setValue((v) => v.split(pasteMarker(i)).join(body))
                  /**
                   * Emptied, NOT removed.
                   *
                   * A marker is its index, so dropping one out of the middle
                   * would renumber the rest and `[pasted #2]` would expand
                   * into the wrong text. Blanking the slot keeps every other
                   * marker pointing where it always did, and expanding a
                   * marker that is no longer in the box is a no-op.
                   */
                  setPastes((prev) => prev.map((b, k) => (k === i ? '' : b)))
                }}
              >
                <span className="paste-label">{pasteMarker(i)}</span>
                <span className="paste-size">{summarise(body)}</span>
              </button>
            ) : null
          )}
        </div>
      )}

      {/*
        What the model is doing, so a turn heading the wrong way can be
        stopped before it finishes. Deliberately quiet: muted grey, no
        border, no background. It sits above the box for the seconds a reply
        takes and then goes, and anything louder than the answer itself
        would be the wrong way round.
      */}
      {activity && (
        <div className={`activity ${activity.kind === 'compact' ? 'is-working' : ''}`} role="status" aria-live="polite">
          <span className="activity-dot" aria-hidden="true" />
          <span className="activity-label">{activity.label}</span>
          {activity.count > 1 && <span className="activity-count">{activity.count}</span>}
          {activity.detail && <span className="activity-detail">{activity.detail}</span>}
          {streaming && <span className="activity-stop">Esc to stop</span>}
          {/* Indeterminate on purpose: compaction is one request to a model
              and there is no honest fraction to show, only that it is going. */}
          {activity.kind === 'compact' && <span className="activity-bar" aria-hidden="true" />}
        </div>
      )}

      {queued.length > 0 && (
        <button
          type="button"
          className="queued"
          onClick={onUnqueue}
          title="Waiting for the current answer to finish. Click to take the first one back."
        >
          <span className="queued-label">
            {queued.length > 1 ? `Queued ${queued.length}` : 'Queued'}
          </span>
          <span className="queued-text">{queued[0]}</span>
        </button>
      )}

      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={
            streaming ? 'Still answering — Enter queues, /also adds a note' : placeholder
          }
          onChange={(e) => {
            spaceWithoutKey(e)
            setValue(e.target.value)
            // Editing a recalled line makes it the draft again, so Down stops
            // trying to put the old half-written one back.
            if (history.browsing) history.reset()
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            // Only the key, not the modifiers. Whether it was a plain space
            // decided whether to start; by the time it comes up, Shift may have
            // been let go first, and a release that failed to match would leave
            // the machine listening with nothing to end it.
            if (!dictation.enabled || (e.key !== ' ' && e.code !== 'Space')) return
            traceKey(e, 'u')
            applyHold(hold.current.up(performance.now()), e)
          }}
          onBlur={abandonHold}
          onPaste={(e) => {
            const files = filesIn(e.clipboardData?.items)
            // Text pasted alongside an image still pastes; only an event
            // that is nothing but images is taken over.
            const pasted = e.clipboardData?.getData('text/plain') ?? ''
            if (files.length && !pasted) {
              e.preventDefault()
              void attach(files)
              return
            }
            /**
             * A pasted log goes in whole and shows as one line.
             *
             * Dropping six hundred lines into the box makes it most of the
             * panel and every keystroke after it repaint the lot. The text is
             * kept exactly as pasted and put back at send; only what is on
             * screen is folded. See bulk.ts.
             */
            if (!foldsPaste(pasted)) return
            e.preventDefault()
            const el = ref.current
            const at = el ? el.selectionStart : value.length
            const to = el ? el.selectionEnd : value.length
            setPastes((prev) => {
              const marker = pasteMarker(prev.length)
              setValue(value.slice(0, at) + marker + value.slice(to))
              // The caret goes after the marker, as it would after a paste.
              requestAnimationFrame(() => {
                const pos = at + marker.length
                el?.setSelectionRange(pos, pos)
              })
              return [...prev, pasted]
            })
          }}
        />
        {/* Paste and drop cover most of it; the button is for the times
            the picture is a file you have to go and find. */}
        <input
          ref={fileInput}
          type="file"
          /* Anything. What a file IS gets decided from its bytes, not from
             a filter that used to make a dropped .ts file vanish. */
          multiple
          hidden
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []))
            // Cleared, or picking the same file twice in a row does nothing.
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="btn-attach"
          onClick={() => fileInput.current?.click()}
          /* The button no longer has a type to name: anything can be attached,
             and what happens to it depends on what it turns out to be. The
             second line is the one difference the model still makes. */
          title={
            canSeeMedia
              ? 'Attach a file of any sort (or just drop or paste one)'
              : describedBy
                ? `Attach a file. This model cannot see, so ${describedBy} reads any image for it and passes on what it says`
                : 'Attach a file. This model cannot see pictures, sound or PDFs, but text files work'
          }
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <Mic dictation={dictation} />
        {streaming ? (
          <button className="btn-stop" type="button" onClick={onStop} title="Stop (Ctrl+C or Esc)">
            Stop
          </button>
        ) : (
          <button
            className="btn-send"
            type="button"
            onClick={submit}
            disabled={!value.trim() && images.length === 0}
            title="Send (Enter)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M4 12h15M13 6l6 6-6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

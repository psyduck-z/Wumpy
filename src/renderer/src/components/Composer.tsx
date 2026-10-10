import { useEffect, useMemo, useRef, useState } from 'react'
import { allCommands, completions, type CommandSpec } from '../commands'
import { CommandPalette } from './CommandPalette'
import { useInputHistory } from '../hooks/useInputHistory'
import { insistFocus } from '../focus'
import { adoptsKeystroke } from '../keyboard'
import { useDictation } from '../hooks/useDictation'
import { HOLD_MS, HoldToTalk, isPlainSpace, type HoldAction } from '../holdtotalk'
import { Mic } from './Mic'
import { mediaIn, readMedia, TOKENS_PER_SECOND } from '../media'
import type { Attachment } from '@shared/types'

/** m:ss, for the length of a clip. */
function clockOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function Composer({
  onSend,
  onStop,
  streaming,
  queued = null,
  onUnqueue,
  focusToken,
  prefill,
  placeholder,
  canSeeMedia = false,
  onSay
}: {
  onSend(text: string, images?: Attachment[]): void
  onStop(): void
  streaming: boolean
  /** Shown as a chip under the box: typed while busy, sent when the turn ends. */
  queued?: string | null
  onUnqueue?(): void
  /** Bumped whenever the panel is shown, so the caret lands in the box. */
  focusToken: number
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
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const attach = async (files: File[]): Promise<void> => {
    if (!files.length) return
    if (!canSeeMedia) {
      onSay?.('This model cannot read images or video. Switch with /model.')
      return
    }
    for (const file of files) {
      try {
        const attachment = await readMedia(file)
        setImages((list) => [...list, attachment])
      } catch (err) {
        onSay?.((err as Error)?.message ?? 'Could not read that file.')
      }
    }
    ref.current?.focus({ preventScroll: true })
  }

  const drop = (e: React.DragEvent): void => {
    const files = mediaIn(e.dataTransfer?.files)
    // Only swallow the event when there was actually an image in it; a file
    // dragged in by mistake should land wherever it would have landed.
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

  const stopTimer = (): void => {
    if (holdTimer.current === null) return
    clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  const applyHold = (action: HoldAction, e?: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (action.swallow) e?.preventDefault()

    if (action.kind === 'arm') {
      stopTimer()
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null
        applyHold(hold.current.tick(performance.now()))
      }, HOLD_MS + 16)
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
      dictation.beginHold()
      return
    }

    if (action.kind === 'send') {
      stopTimer()
      dictation.finish()
      return
    }

    if (action.kind === 'cancel') {
      stopTimer()
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
      () => window.wumpy.panel.requestFocus()
    )
  }, [focusToken])

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
    onSend(value, images.length ? images : undefined)
    setValue('')
    setImages([])
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
    if (dictation.enabled && isPlainSpace(e)) {
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
      // for both, so without this the palette swallowed it.
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
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

    // History, once the palette has had its say. Only from the edge of the
    // text, so arrowing around a multi-line draft still moves the caret: Up on
    // the first line, Down on the last.
    const el = e.currentTarget
    if (e.key === 'ArrowUp' && !e.shiftKey && atFirstLine(el)) {
      const prev = history.older(value)
      if (prev !== null) {
        e.preventDefault()
        recall(prev)
      }
      return
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && atLastLine(el)) {
      const next = history.newer()
      if (next !== null) {
        e.preventDefault()
        recall(next)
      }
    }
  }

  /** True when the caret sits on the first line, so Up has nowhere else to go. */
  function atFirstLine(el: HTMLTextAreaElement): boolean {
    if (el.selectionStart !== el.selectionEnd) return false
    return !el.value.slice(0, el.selectionStart).includes('\n')
  }

  /** True when the caret sits on the last line. */
  function atLastLine(el: HTMLTextAreaElement): boolean {
    if (el.selectionStart !== el.selectionEnd) return false
    return !el.value.slice(el.selectionEnd).includes('\n')
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
              ) : (
                <img src={img.dataUrl} alt={img.name ?? 'Pasted image'} />
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
              <span className="attachment-size">
                {img.kind === 'video' && img.seconds
                  ? `${clockOf(img.seconds)} · ~${Math.round((img.seconds * TOKENS_PER_SECOND) / 100) / 10}k`
                  : `${Math.round(img.bytes / 1024)}KB`}
              </span>
            </div>
          ))}
        </div>
      )}

      {queued && (
        <button
          type="button"
          className="queued"
          onClick={onUnqueue}
          title="Waiting for the current answer to finish. Click to take it back."
        >
          <span className="queued-label">Queued</span>
          <span className="queued-text">{queued}</span>
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
            if (!dictation.enabled || e.key !== ' ') return
            applyHold(hold.current.up(), e)
          }}
          onBlur={abandonHold}
          onPaste={(e) => {
            const files = mediaIn(e.clipboardData?.items)
            // Text pasted alongside an image still pastes; only an event
            // that is nothing but images is taken over.
            if (!files.length) return
            if (e.clipboardData?.getData('text/plain')) return
            e.preventDefault()
            void attach(files)
          }}
        />
        {/* Paste and drop cover most of it; the button is for the times
            the picture is a file you have to go and find. */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
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
          title={
            canSeeMedia
              ? 'Attach an image or a video (or just paste one)'
              : 'This model cannot read images'
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { completions, type CommandSpec } from '../commands'
import { CommandPalette } from './CommandPalette'
import { useInputHistory } from '../hooks/useInputHistory'

export function Composer({
  onSend,
  onStop,
  streaming,
  focusToken,
  prefill,
  placeholder
}: {
  onSend(text: string): void
  onStop(): void
  streaming: boolean
  /** Bumped whenever the panel is shown, so the caret lands in the box. */
  focusToken: number
  /**
   * Text to drop into the box, with a token so the same text twice still
   * lands. Used by the command menu for commands that take an argument.
   */
  prefill?: { text: string; token: number }
  placeholder: string
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const history = useInputHistory()

  /** Puts a recalled line in the box with the caret at the end of it. */
  const recall = (text: string): void => {
    setValue(text)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }

  // Only offer the palette while the command name is still being typed; once
  // there is a space the user has moved on to the argument.
  const palette = useMemo(() => {
    if (!value.startsWith('/') || /\s/.test(value)) return [] as CommandSpec[]
    return completions(value)
  }, [value])

  useEffect(() => setSelected(0), [value])
  useEffect(() => ref.current?.focus(), [focusToken])

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
    if (!value.trim() || streaming) return
    history.push(value)
    onSend(value)
    setValue('')
  }

  const accept = (spec: CommandSpec): void => {
    // Commands that take an argument keep the caret going; the rest can run.
    setValue(spec.arg ? `/${spec.name} ` : `/${spec.name}`)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
        // Enter accepts the highlighted command rather than sending a partial one.
        const spec = palette[selected]
        if (spec) {
          e.preventDefault()
          if (spec.arg) {
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
    <div className="composer-wrap">
      <CommandPalette items={palette} selected={selected} onPick={accept} />

      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={streaming ? 'Wumpy is answering…' : placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            // Editing a recalled line makes it the draft again, so Down stops
            // trying to put the old half-written one back.
            if (history.browsing) history.reset()
          }}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button className="btn-stop" type="button" onClick={onStop} title="Stop (Esc)">
            Stop
          </button>
        ) : (
          <button
            className="btn-send"
            type="button"
            onClick={submit}
            disabled={!value.trim()}
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

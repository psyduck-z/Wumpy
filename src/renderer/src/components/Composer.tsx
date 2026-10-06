import { useEffect, useMemo, useRef, useState } from 'react'
import { completions, type CommandSpec } from '../commands'
import { CommandPalette } from './CommandPalette'

export function Composer({
  onSend,
  onStop,
  streaming,
  focusToken,
  placeholder
}: {
  onSend(text: string): void
  onStop(): void
  streaming: boolean
  /** Bumped whenever the panel is shown, so the caret lands in the box. */
  focusToken: number
  placeholder: string
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Only offer the palette while the command name is still being typed; once
  // there is a space the user has moved on to the argument.
  const palette = useMemo(() => {
    if (!value.startsWith('/') || /\s/.test(value)) return [] as CommandSpec[]
    return completions(value)
  }, [value])

  useEffect(() => setSelected(0), [value])
  useEffect(() => ref.current?.focus(), [focusToken])

  // Grow with the content up to a ceiling, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [value])

  const submit = (): void => {
    if (!value.trim() || streaming) return
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
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && palette.length > 0)) {
        // Enter accepts the highlighted command rather than sending a partial one.
        const spec = palette[selected]
        if (spec) {
          e.preventDefault()
          if (spec.arg) {
            accept(spec)
          } else {
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
    }
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
          onChange={(e) => setValue(e.target.value)}
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

import { useEffect, useRef, useState } from 'react'

export function Composer({
  onSend,
  onStop,
  streaming,
  focusToken
}: {
  onSend(text: string): void
  onStop(): void
  streaming: boolean
  /** Bumped whenever the panel is shown, so the caret lands in the box. */
  focusToken: number
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [focusToken])

  // Grow with the content up to a ceiling, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  const submit = (): void => {
    if (!value.trim() || streaming) return
    onSend(value)
    setValue('')
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder={streaming ? 'Wumpy is answering…' : 'Ask Wumpy anything…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {streaming ? (
        <button className="btn-stop" type="button" onClick={onStop} title="Stop generating">
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
          Send
        </button>
      )}
    </div>
  )
}

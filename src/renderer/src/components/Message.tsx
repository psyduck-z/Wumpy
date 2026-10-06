import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { Markdown } from './Markdown'
import { useSmoothText } from '../hooks/useSmoothText'

export function Message({
  message,
  streaming,
  showReasoning,
  onGrow
}: {
  message: ChatMessage
  streaming: boolean
  /** When false the scratchpad is collapsed behind a disclosure. */
  showReasoning: boolean
  /** Called as revealed text grows, so the transcript can stay pinned. */
  onGrow?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(showReasoning)
  const isUser = message.role === 'user'

  // Reveal the answer smoothly rather than in the lumps the tokens arrive in.
  const [shown, catchingUp] = useSmoothText(message.content, streaming)
  const animating = streaming || catchingUp

  // Follow the global preference when it changes, but let a click override it
  // for this message.
  useEffect(() => setOpen(showReasoning), [showReasoning])

  useEffect(() => {
    onGrow?.()
  }, [shown, onGrow])

  // A compaction summary standing in for earlier turns.
  if (message.summary) {
    return (
      <div className="msg msg-summary">
        <button type="button" className="summary-chip" onClick={() => setOpen((v) => !v)}>
          <span className={`caret-glyph ${open ? 'is-open' : ''}`}>&#9656;</span>
          Compacted {message.summarised ?? 0} earlier message
          {message.summarised === 1 ? '' : 's'}
        </button>
        {open && (
          <div className="summary-body">
            <Markdown text={message.content} />
          </div>
        )}
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="msg msg-user">
        <div className="msg-body">{message.content}</div>
      </div>
    )
  }

  const waiting = !shown && !message.error

  return (
    <div className="msg msg-assistant">
      {message.thinking && (
        <div className="thinking">
          <button type="button" onClick={() => setOpen((v) => !v)}>
            <span className={`caret-glyph ${open ? 'is-open' : ''}`}>&#9656;</span>
            {open ? 'Hide' : 'Show'} reasoning
            {streaming && !message.content ? ' · thinking…' : ''}
          </button>
          {open && <pre>{message.thinking}</pre>}
        </div>
      )}

      {/* While streaming, `is-streaming` draws the caret as a pseudo-element on
          the last block so it flows inline after the final character rather than
          dropping onto a line of its own. */}
      {message.error ? (
        <div className="msg-error">{message.error}</div>
      ) : (
        <div className={`msg-body ${animating && !waiting ? 'is-streaming' : ''}`}>
          <Markdown text={shown} />
          {waiting && !message.thinking && (
            <span className="dots" role="status" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { Markdown } from './Markdown'

export function Message({
  message,
  streaming,
  showReasoning
}: {
  message: ChatMessage
  streaming: boolean
  /** When false the scratchpad is collapsed behind a disclosure. */
  showReasoning: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(showReasoning)
  const isUser = message.role === 'user'
  const empty = !message.content && !message.error

  // Follow the global preference when it changes, but let a click override it
  // for this message.
  useEffect(() => setOpen(showReasoning), [showReasoning])

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      {!isUser && message.thinking && (
        <div className="thinking">
          <button type="button" onClick={() => setOpen((v) => !v)}>
            <span className={`caret-glyph ${open ? 'is-open' : ''}`}>&#9656;</span>
            {open ? 'Hide' : 'Show'} reasoning
            {streaming && !message.content ? ' · thinking…' : ''}
          </button>
          {open && <pre>{message.thinking}</pre>}
        </div>
      )}

      {message.error ? (
        <div className="msg-error">{message.error}</div>
      ) : isUser ? (
        <div className="msg-body">{message.content}</div>
      ) : (
        <div className="msg-body">
          <Markdown text={message.content} />
          {streaming && empty && !message.thinking && <span className="dots" aria-label="Thinking" />}
          {streaming && !empty && <span className="caret" />}
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { Markdown } from './Markdown'

export function Message({
  message,
  streaming
}: {
  message: ChatMessage
  streaming: boolean
}): React.JSX.Element {
  const [showThinking, setShowThinking] = useState(false)
  const isUser = message.role === 'user'
  const empty = !message.content && !message.error

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      {!isUser && message.thinking && (
        <div className="thinking">
          <button type="button" onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? 'Hide' : 'Show'} reasoning
          </button>
          {showThinking && <pre>{message.thinking}</pre>}
        </div>
      )}

      {message.error ? (
        <div className="msg-error">{message.error}</div>
      ) : isUser ? (
        <div className="msg-body">{message.content}</div>
      ) : (
        <div className="msg-body">
          <Markdown text={message.content} />
          {streaming && empty && <span className="dots" aria-label="Thinking" />}
          {streaming && !empty && <span className="caret" />}
        </div>
      )}
    </div>
  )
}

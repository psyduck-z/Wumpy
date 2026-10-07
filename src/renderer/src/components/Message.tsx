import { memo, useEffect, useState } from 'react'
import type { ChatMessage, SearchResult, ShellKind, ShellResult, TierId } from '@shared/types'
import { Markdown } from './Markdown'
import { AskCard } from './AskCard'
import { useSmoothText } from '../hooks/useSmoothText'

/**
 * Memoised on purpose.
 *
 * Every arriving token updates the message array, which re-rendered every
 * message in the chat. In a long conversation that is a lot of markdown
 * re-parsing per token, competing with the model for the same cores.
 */
export const Message = memo(function Message({
  message,
  streaming,
  showReasoning,
  smoothText,
  tier,
  canAutoRun,
  onGrow,
  onRunCommand,
  onCommandResult,
  onAnswer,
  onSearch,
  onSearchResults
}: {
  message: ChatMessage
  streaming: boolean
  /** When false the scratchpad is collapsed behind a disclosure. */
  showReasoning: boolean
  /** Reveal character by character rather than token by token. */
  smoothText: boolean
  /** The active tier, which decides what a proposed command may do. */
  tier: TierId
  /**
   * Whether a command this message proposes may run unattended. Omitted for
   * messages that were not generated in this session, so reopening a saved chat
   * never re-runs what it contains.
   */
  canAutoRun?: (command: string, messageId: string) => boolean
  /** Called as revealed text grows, so the transcript can stay pinned. */
  onGrow?: () => void
  /** Supplied only when the active tier may propose commands. */
  onRunCommand?: (command: string, shell: ShellKind) => Promise<ShellResult | null>
  onCommandResult?: (result: ShellResult, unattended: boolean) => void
  /** Called when the user picks an option from a question the model asked. */
  onAnswer?: (messageId: string, option: string) => void
  /** Supplied when the tier may search the web. */
  onSearch?: (query: string) => Promise<{ results: SearchResult[]; provider: string; error?: string }>
  onSearchResults?: (
    query: string,
    results: SearchResult[],
    provider: string,
    error?: string
  ) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(showReasoning)
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  // Reveal the answer smoothly rather than in the lumps the tokens arrive in.
  const [shown, catchingUp] = useSmoothText(message.content, streaming, smoothText)
  const animating = streaming || catchingUp

  // Follow the global preference when it changes, but let a click override it
  // for this message.
  useEffect(() => setOpen(showReasoning), [showReasoning])

  useEffect(() => {
    onGrow?.()
  }, [shown, onGrow])

  // A question Wumpy is asking directly, with no model involved.
  if (message.localAsk) {
    return (
      <div className="msg msg-assistant">
        <AskCard
          question={message.localAsk.question}
          options={message.localAsk.options}
          answered={message.answered ?? null}
          onAnswer={(option) => onAnswer?.(message.id, option)}
        />
      </div>
    )
  }

  // An app-generated fact, e.g. "you can now run commands".
  if (message.notice) {
    return (
      <div className="msg msg-notice">
        <span className={`notice-chip ${message.aside ? 'is-aside' : ''}`}>{message.content}</span>
      </div>
    )
  }

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
            <Markdown text={message.content} tier={tier} />
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
      {/* Code blocks could always be copied; the answer around them could not. */}
      {!animating && !message.error && message.content.trim() && (
        <button type="button" className="msg-copy" onClick={copy} title="Copy this answer">
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}

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
          <Markdown
            text={shown}
            tier={tier}
            complete={!animating}
            canAutoRun={canAutoRun}
            messageId={message.id}
            onRunCommand={onRunCommand}
            onCommandResult={onCommandResult}
            onAnswer={onAnswer ? (option) => onAnswer(message.id, option) : undefined}
            answered={message.answered ?? null}
            onSearch={onSearch}
            onSearchResults={onSearchResults}
          />
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
})

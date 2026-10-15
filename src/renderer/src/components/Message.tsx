import { memo, useEffect, useState, type ReactNode } from 'react'
import type {
  Attachment,
  DesktopResult,
  ChatMessage,
  LinkResult,
  SearchResult,
  ShellKind,
  ShellResult,
  WriteResult,
  WriteTarget
} from '@shared/types'
import type { LinkApproval } from '@shared/links'
import { sizeLabel } from '@shared/attach'
import { inlineCode } from '@shared/notify'
import { foldLabel, foldWorking } from '@shared/working'
import { Markdown } from './Markdown'
import { AskCard } from './AskCard'
import { useSmoothText } from '../hooks/useSmoothText'
import { copyText } from '../copy'

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
  canAutoRun,
  onGrow,
  onRunCommand,
  onCommandResult,
  onAnswer,
  onSearch,
  onSearchResults,
  onCaptureScreen,
  onScreenCaptured,
  onDesktop,
  onDesktopDone,
  onOpenLink,
  onOpenSearch,
  onOpened,
  onWriteFile,
  onCheckWrite,
  onWritten,
  autoWrite,
  linkMode,
  searchEngine,
  looseFences
}: {
  message: ChatMessage
  streaming: boolean
  /** When false the scratchpad is collapsed behind a disclosure. */
  showReasoning: boolean
  /** Reveal character by character rather than token by token. */
  smoothText: boolean
  /**
   * Whether a command this message proposes may run unattended. Omitted for
   * messages that were not generated in this session, so reopening a saved chat
   * never re-runs what it contains.
   */
  canAutoRun?: (command: string, messageId: string) => boolean
  /** Called as revealed text grows, so the transcript can stay pinned. */
  onGrow?: () => void
  /** Supplied only when Wumpy may propose commands. */
  onRunCommand?: (command: string, shell: ShellKind, runId?: string) => Promise<ShellResult | null>
  onCommandResult?: (result: ShellResult, unattended: boolean) => void
  /** Called when the user picks an option from a question the model asked. */
  onAnswer?: (messageId: string, option: string) => void
  /** Supplied when Wumpy may search the web. */
  onWriteFile?: (path: string, content: string) => Promise<WriteResult>
  onCheckWrite?: (path: string) => Promise<WriteTarget>
  onWritten?: (result: WriteResult, messageId: string) => void
  autoWrite?: boolean
  onCaptureScreen?: () => Promise<Attachment>
  onScreenCaptured?: (shot: Attachment) => void
  onDesktop?: (body: string) => Promise<DesktopResult>
  onDesktopDone?: (result: DesktopResult, after: Attachment | null) => void
  onOpenLink?: (url: string) => Promise<LinkResult>
  onOpenSearch?: (query: string) => Promise<LinkResult>
  onOpened?: (result: LinkResult, messageId: string) => void
  linkMode?: LinkApproval
  searchEngine?: string
  /** This model writes ```powershell instead of ```wumpy-run. */
  looseFences?: boolean
  onSearch?: (
    query: string
  ) => Promise<{ results: SearchResult[]; provider: string; error?: string }>
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
    /* Through the main process: the page's own clipboard needs document focus
       and this panel often does not have it. The badge now follows what
       actually happened rather than the attempt. */
    void copyText(message.content).then((ok) => {
      if (!ok) return
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
          groups={[{ question: message.localAsk.question, options: message.localAsk.options }]}
          answered={message.answered ?? null}
          onAnswer={(option) => onAnswer?.(message.id, option)}
        />
      </div>
    )
  }

  /*
   * What Wumpy just did, in its own voice.
   *
   * The hand-back it belongs to is sent and not shown, so this is the only
   * line in the transcript for a command that ran - and the only place the
   * repeat count can go. Quieter than a notice: a notice is something the
   * model must act on, this is a receipt.
   */
  if (message.notification) {
    return (
      <div className="msg msg-notice">
        <span className="notice-chip is-receipt">
          <Chip text={message.content} repeat={message.repeat} />
        </span>
      </div>
    )
  }

  // An app-generated fact, e.g. "you can now run commands".
  if (message.notice) {
    return (
      <div className="msg msg-notice">
        <span className={`notice-chip ${message.aside ? 'is-aside' : ''}`}>
          <Chip text={message.content} repeat={message.repeat} />
        </span>
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
            <Markdown text={message.content} />
          </div>
        )}
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="msg msg-user">
        {/* Above the text, the way they were above the box when it was sent.
            A message can be an image and nothing else. */}
        {message.images?.length ? (
          <div className="msg-images">
            {message.images.map((img, i) =>
              img.kind === 'video' ? (
                // Controls, unlike the composer chip: once it is sent this
                // is the record of what was asked, and worth replaying.
                <video key={i} src={img.dataUrl} controls preload="metadata" />
              ) : img.kind === 'audio' ? (
                <audio key={i} src={img.dataUrl} controls preload="metadata" />
              ) : img.kind === 'image' ? (
                <img key={i} src={img.dataUrl} alt={img.name ?? 'Attached image'} />
              ) : (
                /*
                 * A file that went up as characters, or as a line saying it
                 * could not. It is in the record because what was attached is
                 * part of what was asked - and because "why did it answer
                 * about the wrong file" is unanswerable without it.
                 */
                <span
                  key={i}
                  className={`msg-file${img.kind === 'opaque' ? ' is-unread' : ''}`}
                  title={
                    img.kind === 'opaque'
                      ? `${sizeLabel(img.bytes)} — attached, but this format could not be read`
                      : `${(img.chars ?? 0).toLocaleString()} characters${img.truncated ? ', partly sent' : ''}`
                  }
                >
                  {img.name ?? 'attached file'}
                  {img.kind === 'text' && img.truncated ? ' (part)' : ''}
                  {img.kind === 'opaque' ? ' (not read)' : ''}
                </span>
              )
            )}
          </div>
        ) : null}
        {message.content ? <div className="msg-body">{message.content}</div> : null}
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
          {/* One <Markdown> per segment, which is one segment unless the
              answer turned into a search. See shared/working.ts. */}
          {foldWorking(shown).map((segment, i) => {
            const body = (
              <Markdown
                text={segment.body}
                complete={!animating}
                canAutoRun={canAutoRun}
                messageId={message.id}
                onRunCommand={onRunCommand}
                onCommandResult={onCommandResult}
                onAnswer={onAnswer ? (option) => onAnswer(message.id, option) : undefined}
                answered={message.answered ?? null}
                onSearch={onSearch}
                onSearchResults={onSearchResults}
                onWriteFile={onWriteFile}
                onCheckWrite={onCheckWrite}
                onWritten={onWritten}
                autoWrite={autoWrite}
                onCaptureScreen={onCaptureScreen}
                onScreenCaptured={onScreenCaptured}
                onDesktop={onDesktop}
                onDesktopDone={onDesktopDone}
                onOpenLink={onOpenLink}
                onOpenSearch={onOpenSearch}
                onOpened={onOpened}
                linkMode={linkMode}
                searchEngine={searchEngine}
                looseFences={looseFences}
              />
            )
            return segment.working ? (
              <Working key={i} lines={segment.lines}>
                {body}
              </Working>
            ) : (
              <div key={i}>{body}</div>
            )
          })}
          {waiting && !message.thinking && (
            <span className="dots" role="status" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      )}

      {/* An answer that stopped rather than finished. Said here, under the
          text it belongs to, because everything else about the end of a turn
          is identical either way — the dots go, the runtime prints, and half
          a sentence reads as all there was to say. */}
      {message.cutOff && !message.error && !animating && (
        <div className="msg-cutoff">
          {message.cutOff === 'content_filter'
            ? 'The provider stopped this answer part-way.'
            : 'This hit the length limit and stopped part-way. Say “carry on” for the rest.'}
        </div>
      )}
    </div>
  )
})

/**
 * A chip's text, with `a command` set as code and a count on the end.
 *
 * The chips were plain text, so every backtick Wumpy wrote was a backtick on
 * screen - "Ran `x` - succeeded, no output" has been saying that since the
 * day it was added. Not the markdown renderer: that is a react-markdown tree
 * per chip for one span of code inside a 10px line.
 *
 * The count appears only on a repeat, and it is the whole point of the chip
 * being one message rather than six: the same command running four times is
 * one line reading four, not four lines reading one.
 */
function Chip({ text, repeat }: { text: string; repeat?: number }): React.JSX.Element {
  const times = repeat ?? 1
  return (
    <>
      {inlineCode(text).map((part, i) =>
        part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>
      )}
      {times > 1 && (
        <span className="chip-count" title={`This happened ${times} times`}>
          &#215;{times}
        </span>
      )}
    </>
  )
}

/**
 * A run of attempts, behind one line.
 *
 * Asked an analogy question and then an anagram, Wumpy listed out every
 * possibility it could think of and then hit the output cap part-way
 * through the list, so what arrived was the search and not the answer.
 * "At least compact it, saying like searching patterns."
 *
 * Shut by default and shut again each time the run grows, because the
 * point is not to watch it: the summary says how much is behind it, and
 * opening it is a decision rather than the default.
 */
function Working({ lines, children }: { lines: number; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`working ${open ? 'is-open' : ''}`}>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        <span className={`caret-glyph ${open ? 'is-open' : ''}`} aria-hidden="true">
          &#9656;
        </span>
        {foldLabel(lines)}
      </button>
      {open && <div className="working-body">{children}</div>}
    </div>
  )
}

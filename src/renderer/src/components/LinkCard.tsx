import { useEffect, useRef, useState } from 'react'
import {
  checkLink,
  DEFAULT_ENGINE,
  isSearchEngine,
  linkOpensItself,
  readLinkRequest,
  searchUrl,
  type LinkApproval
} from '@shared/links'
import type { LinkResult } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { KIND_FAMILY } from '../kinds'
import { KindMark } from './KindMark'

/**
 * A page the model wants to open, and the button that allows it.
 *
 * Gated like a command, and the gate is the host. A link is the one proposal in
 * this app whose text says nothing reliable about what it does: the words can
 * read "the Electron docs" while the address goes somewhere else, and this app
 * feeds the model web pages, so the address may be one a page asked for. So the
 * host is shown on its own line, in full, as a browser would resolve it -
 * punycoded, so a homograph cannot wear a real site's name.
 *
 * A search is a different thing and is treated as one: Wumpy builds that URL from
 * the query, so the destination is a search engine whatever the query says.
 */
export function LinkCard({
  request: raw,
  complete = true,
  mode,
  engine,
  onOpen,
  onSearch,
  onOpened,
  messageId
}: {
  request: string
  /** False while the message is still arriving and the link half-written. */
  complete?: boolean
  mode: LinkApproval
  engine: string
  onOpen(url: string): Promise<LinkResult>
  onSearch(query: string): Promise<LinkResult>
  /** Reports back so the transcript records what was opened. */
  onOpened(result: LinkResult, messageId: string): void
  messageId: string
}): React.JSX.Element {
  const { reason, query, target } = readLinkRequest(raw)

  // A search is checked against the URL this app would build, not the query, so
  // the card describes the page that will actually open.
  const check = checkLink(
    query ? searchUrl(query, isSearchEngine(engine) ? engine : DEFAULT_ENGINE) : (target ?? '')
  )
  const source = query ? 'search' : 'model'

  const [state, setState] = useState<'idle' | 'opening' | 'done' | 'skipped' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const opened = useRef(false)

  const go = async (): Promise<void> => {
    if (!claimOnce(`open:${messageId}:${check.url}`)) return
    opened.current = true
    setState('opening')
    const result = query ? await onSearch(query) : await onOpen(check.url)
    if (result.opened) {
      setState('done')
    } else {
      setState('failed')
      setError(result.error ?? 'Could not open it.')
    }
    onOpened(result, messageId)
  }

  // Opening by itself, when the mode allows it. Only once the fence has closed:
  // a half-written URL is a different URL.
  const itself = complete && linkOpensItself(check, source, mode)
  useEffect(() => {
    if (!itself || state !== 'idle' || opened.current) return
    void go()
    // Only the decision, so a re-render mid-open cannot start a second one.
  }, [itself, state])

  const waiting = state === 'idle' && complete && check.ok && !itself

  /**
   * Registered so Ctrl+Enter reaches this too.
   *
   * Commands could always be approved from the keyboard and these could not,
   * which made the shortcut a half-truth: the hands stayed put for one kind
   * of proposal and went to the mouse for the other two.
   */
  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + (check.host ?? 'a page'), {
      command: check.host ?? 'a page',
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId])

  /** The card itself, so the arrow keys can find its buttons. */
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      data-family={KIND_FAMILY.link}
      className={`cmd link ${state === 'failed' || !check.ok ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <KindMark kind="link" />
        <span className="cmd-shell">{query ? 'Web search' : 'Open page'}</span>
        {check.ok && <span className="cmd-status link-host">{check.host}</span>}
        {check.local && <span className="cmd-status link-local">on this machine</span>}
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              Skip
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              Open
            </button>
          </>
        )}
        {state === 'opening' && <span className="cmd-status">opening…</span>}
        {state === 'done' && <span className="cmd-status">opened in your browser</span>}
        {state === 'skipped' && <span className="cmd-status">skipped</span>}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}

      {/*
        Refused links still show what was asked for. Hiding it would leave the
        user with a complaint and no way to see what prompted it.
      */}
      {!check.ok ? (
        <>
          <pre className="cmd-body">{(target ?? query ?? '').slice(0, 300)}</pre>
          <p className="link-refused">{check.why}</p>
        </>
      ) : (
        <pre className="cmd-body">{query ? query : check.url}</pre>
      )}

      {error && <p className="link-refused">{error}</p>}
    </div>
  )
}


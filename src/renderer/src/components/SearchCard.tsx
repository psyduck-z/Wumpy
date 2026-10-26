import { useEffect, useRef, useState } from 'react'
import type { SearchResult } from '@shared/types'
import type { LinkApproval } from '@shared/links'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { KIND_FAMILY } from '../kinds'
import { KindMark } from './KindMark'

const PROVIDER_LABEL: Record<string, string> = {
  brave: 'Brave Search',
  duckduckgo: 'DuckDuckGo',
  wikipedia: 'Wikipedia',
  none: 'no source'
}

/**
 * A web search the model has proposed, with the button that approves it.
 *
 * Searching is gated the same way running a command is, and for the same
 * reason: the query leaves the machine. A model can put anything into one,
 * including something it has just read, so the exact words are shown before
 * they are sent anywhere.
 */
export function SearchCard({
  query: raw,
  complete = true,
  mode = 'manual',
  messageId = '',
  onSearch,
  onResults
}: {
  query: string
  /** False while the message is still arriving and the query half-written. */
  complete?: boolean
  /**
   * The approval mode, which this card used to ignore entirely.
   *
   * It always drew Skip and Search, in every mode, which made accept-all a
   * lie: everything else ran by itself and the most harmless proposal in the
   * app still stopped and asked. A search changes nothing on the machine, and
   * the same policy already lets a search Wumpy builds open its own results
   * page unattended - see linkOpensItself. This matches it.
   */
  mode?: LinkApproval
  messageId?: string
  onSearch(query: string): Promise<{ results: SearchResult[]; provider: string; error?: string }>
  onResults(query: string, results: SearchResult[], provider: string, error?: string): void
}): React.JSX.Element {
  // Same convention as commands: a leading # line says why.
  const lines = raw.split('\n')
  const reason = lines
    .filter((l) => l.trim().startsWith('#'))
    .map((l) => l.replace(/^\s*#+\s*/, ''))
    .join(' ')
  const query = lines
    .filter((l) => !l.trim().startsWith('#'))
    .join(' ')
    .trim()

  const [state, setState] = useState<'idle' | 'running' | 'done' | 'skipped'>('idle')
  const [results, setResults] = useState<SearchResult[]>([])
  const [provider, setProvider] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const go = async (): Promise<void> => {
    setState('running')
    const r = await onSearch(query)
    setResults(r.results)
    setProvider(r.provider)
    setError(r.error ?? null)
    setState('done')
    onResults(query, r.results, r.provider, r.error)
  }

  /**
   * Searching by itself, when the mode allows it.
   *
   * Both automatic modes qualify. Nothing on this machine is read or changed;
   * the only cost is the query leaving, and that is exactly the cost the same
   * modes already accept for a search Wumpy opens in the browser.
   *
   * Guarded by a ref as well as by state, because the effect can run twice
   * for one commit and a doubled search is a wasted request and a doubled
   * block of results in the transcript.
   */
  const itself = complete && Boolean(query) && (mode === 'all' || mode === 'auto')
  const searched = useRef(false)
  useEffect(() => {
    if (!itself || state !== 'idle' || searched.current) return
    // Claimed outside React: a remount would otherwise give this card a fresh
    // ref and spend a second request from the quota on the same query.
    if (!claimOnce(`search:${messageId}:${query}`)) return
    searched.current = true
    void go()
  }, [itself, state])

  const waiting = state === 'idle' && complete && Boolean(query) && !itself

  /** Registered so Ctrl+Enter reaches a search too, like the other cards. */
  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + query, {
      command: query,
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId, query])

  /** The card itself, so the arrow keys can find its buttons. */
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      data-family={KIND_FAMILY.search}
      className={`cmd search ${error ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <KindMark kind="search" />
        <span className="cmd-shell">Web search</span>
        {state === 'done' && provider && (
          <span className="cmd-status">{PROVIDER_LABEL[provider] ?? provider}</span>
        )}
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {state === 'idle' && itself && <span className="cmd-status">searching automatically…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              Skip
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              Search
            </button>
          </>
        )}
        {state === 'running' && <span className="cmd-status">searching…</span>}
        {state === 'skipped' && <span className="cmd-status">skipped</span>}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}
      <pre className="cmd-body">{query}</pre>

      {state === 'done' && (
        <div className="cmd-output">
          {error ? (
            <p className="search-error">{error}</p>
          ) : (
            <ol className="search-results">
              {results.map((r) => (
                <li key={r.url}>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                  {r.snippet && <span className="search-snippet">{r.snippet}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

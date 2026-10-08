import { useState, useRef } from 'react'
import type { SearchResult } from '@shared/types'
import { arrowNavigate } from '../keyboard'

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
  onSearch,
  onResults
}: {
  query: string
  /** False while the message is still arriving and the query half-written. */
  complete?: boolean
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

  /** The card itself, so the arrow keys can find its buttons. */
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      className={`cmd search ${error ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <span className="cmd-shell">Web search</span>
        {state === 'done' && provider && (
          <span className="cmd-status">{PROVIDER_LABEL[provider] ?? provider}</span>
        )}
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {state === 'idle' && complete && (
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

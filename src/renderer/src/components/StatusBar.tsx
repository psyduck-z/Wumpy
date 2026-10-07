import type { ApprovalMode, ContextUsage } from '@shared/types'
import type { ChatStats } from '../hooks/useChat'

/**
 * Elapsed and load times, which on a CPU-only machine and a 14B model can run
 * well past a minute. Seconds alone stopped being readable around "184.3s".
 */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`

  // Round to seconds first, so 59,999ms reads as "1m 0s" rather than "60.0s".
  const total = Math.round(ms / 1000)
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`

  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds}s`
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}

/**
 * How full the context window is. Turns amber past 65%, which is where
 * auto-compaction kicks in, and red once there is very little room left.
 */
function ContextMeter({
  usage,
  onCompact
}: {
  usage: ContextUsage
  onCompact(): void
}): React.JSX.Element {
  const pct = Math.min(100, (usage.used / usage.limit) * 100)
  const level = pct >= 90 ? 'is-critical' : pct >= 65 ? 'is-warn' : ''

  return (
    <button
      type="button"
      className={`ctx ${level}`}
      onClick={onCompact}
      title={
        `Context: ${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} tokens ` +
        `(${pct.toFixed(0)}%)${usage.estimated ? ', estimated' : ', counted by Ollama'}\n` +
        'Click to compact older turns.'
      }
    >
      <span className="ctx-track">
        <span className="ctx-fill" style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <span className="ctx-label">
        {pct.toFixed(0)}%
        {usage.estimated && <span className="ctx-est" title="Estimated from characters">~</span>}
      </span>
    </button>
  )
}

const APPROVAL: Record<ApprovalMode, { label: string; title: string }> = {
  manual: { label: 'manual', title: 'Every command waits for you. Click to change.' },
  auto: {
    label: 'auto',
    title: 'Read-only commands run themselves; anything that changes something asks. Click to change.'
  },
  all: {
    label: 'accept all',
    title: 'Commands run without asking; destructive ones still raise a dialog. Click to change.'
  }
}

export function StatusBar({
  tierLabel,
  model,
  streaming,
  stats,
  usage,
  compact,
  approvalMode,
  onCycleApproval,
  onCompact
}: {
  tierLabel: string
  model: string
  streaming: boolean
  stats: ChatStats
  usage: ContextUsage
  /** The panel is in its small corner shape, so drop the optional parts. */
  compact: boolean
  approvalMode: ApprovalMode
  onCycleApproval(): void
  onCompact(): void
}): React.JSX.Element {
  const elapsed = stats.elapsedMs !== null ? duration(stats.elapsedMs) : null

  // While streaming, derive a live rate from what has arrived so far; once the
  // turn lands, show the rate Ollama reported.
  const liveRate =
    streaming && stats.elapsedMs && stats.elapsedMs > 600
      ? (stats.liveTokens / (stats.elapsedMs / 1000)).toFixed(1)
      : null

  return (
    <footer className="status">
      <span className="status-tier">{tierLabel}</span>
      {!compact && (
        <>
          <span className="status-sep">·</span>
          <span className="status-model">{model}</span>
        </>
      )}

      <span className="spacer" />

      {/* Never leave the user guessing what will run without them. */}
      <button
        type="button"
        className={`approval is-${approvalMode}`}
        onClick={onCycleApproval}
        title={APPROVAL[approvalMode].title}
      >
        {APPROVAL[approvalMode].label}
      </button>


      {streaming ? (
        <span className="status-live">
          {elapsed && <span className="status-num">{elapsed}</span>}
          {stats.liveTokens > 0 && (
            <>
              <span className="status-sep">·</span>
              <span className="status-num">{stats.liveTokens} tok</span>
            </>
          )}
          {liveRate && (
            <>
              <span className="status-sep">·</span>
              <span className="status-num">{liveRate} tok/s</span>
            </>
          )}
        </span>
      ) : stats.speed === null ? (
        // Nothing measured yet, so use the space for discoverability.
        !compact && <span className="status-tip">Ctrl+K for commands</span>
      ) : (
        (
          <span className="status-live">
            <span className="status-num">{stats.speed.toFixed(1)} tok/s</span>
            {!compact && stats.lastCompletionTokens !== null && (
              <>
                <span className="status-sep">·</span>
                <span className="status-num">{compactTokens(stats.lastCompletionTokens)} tok</span>
              </>
            )}
            {/* Only worth showing when the model actually had to load. */}
            {!compact && stats.loadMs !== null && stats.loadMs > 500 && (
              <>
                <span className="status-sep">·</span>
                <span className="status-num">{duration(stats.loadMs)} load</span>
              </>
            )}
          </span>
        )
      )}

      <ContextMeter usage={usage} onCompact={onCompact} />
    </footer>
  )
}

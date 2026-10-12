import type { ApprovalMode, ContextUsage } from '@shared/types'
import type { PoolView } from '@shared/pool'
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
  // The tooltip said "counted by Ollama" until Ollama was removed from the
  // app entirely, naming a backend that is no longer there. Whichever
  // provider is configured reports these counts now.
  const pct = Math.min(100, (usage.used / usage.limit) * 100)
  const level = pct >= 90 ? 'is-critical' : pct >= 65 ? 'is-warn' : ''

  return (
    <button
      type="button"
      className={`ctx ${level}`}
      onClick={onCompact}
      title={
        `Context: ${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} tokens ` +
        `(${pct.toFixed(0)}%)${usage.estimated ? ', estimated' : ', counted by the provider'}\n` +
        'Click to compact older turns.'
      }
    >
      <span className="ctx-track">
        <span className="ctx-fill" style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
      <span className="ctx-label">
        {pct.toFixed(0)}%
        {usage.estimated && (
          <span className="ctx-est" title="Estimated from characters">
            ~
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * How much of the day's free quota is left, and on how many keys.
 *
 * The pool was invisible until it refused something. Twenty keys is twenty
 * separate free tiers and each one dies on its own, so the number that
 * matters is not "how much have I used" but "how many of these can still
 * answer" - which is what this says, in the one place that is always on
 * screen. Clicking it prints the whole thing, key by key.
 *
 * Nothing here is a key or part of one: positions, counts and times only.
 */
function QuotaMeter({
  pool,
  onReport
}: {
  pool: PoolView
  onReport(): void
}): React.JSX.Element | null {
  /* One key and no known cap is the uninteresting case: say nothing. */
  if (pool.keys <= 0) return null

  const pct = pool.usedFraction === null ? null : Math.round(pool.usedFraction * 100)
  const dead = pool.spent > 0
  const level = pool.ready === 0 ? 'is-critical' : pct !== null && pct >= 75 ? 'is-warn' : ''

  const label =
    pool.ready === 0
      ? 'no keys'
      : pct !== null
        ? `${100 - pct}% left`
        : `${pool.ready}/${pool.keys} keys`

  const comesBack =
    pool.nextFreeMs > 0
      ? `Something frees up in ${Math.ceil(pool.nextFreeMs / 60000)} min.`
      : `Everything resets at ${new Date(pool.resetAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit'
        })}.`

  return (
    <button
      type="button"
      className={`quota ${level}`}
      onClick={onReport}
      title={
        `${pool.model}: ${pool.requests} request${pool.requests === 1 ? '' : 's'} today ` +
        `across ${pool.keys} key${pool.keys === 1 ? '' : 's'}.\n` +
        (pool.remaining !== null
          ? `About ${pool.remaining.toLocaleString()} left of ${pool.cap.toLocaleString()}.\n`
          : 'No credible daily cap known for this model yet.\n') +
        `${pool.ready} ready` +
        (dead ? `, ${pool.spent} out for the day` : '') +
        (pool.resting ? `, ${pool.resting} resting a moment` : '') +
        /* The one that needs doing something about, so it is said in the
           hover rather than only in the full report. */
        (pool.rejected ? `, ${pool.rejected} REFUSED — run /key google check` : '') +
        `.\n${comesBack}\nClick for the full breakdown.`
      }
    >
      <span className="quota-dot" aria-hidden="true" />
      <span className="quota-label">{label}</span>
    </button>
  )
}

const APPROVAL: Record<ApprovalMode, { label: string; title: string }> = {
  manual: { label: 'manual', title: 'Every command waits for you. Click to change.' },
  auto: {
    label: 'auto',
    title:
      'Read-only commands run themselves; anything that changes something asks. Click to change.'
  },
  all: {
    label: 'accept all',
    title: 'Everything runs without asking, destructive commands included. Click to change.'
  }
}

export function StatusBar({
  model,
  ready,
  streaming,
  stats,
  usage,
  pool,
  compact,
  approvalMode,
  onCycleApproval,
  onCompact,
  onQuota
}: {
  model: string
  /** False when no key is saved for this model's provider. */
  ready: boolean
  streaming: boolean
  stats: ChatStats
  usage: ContextUsage
  /** The key pool behind this model, or null when there is nothing hosted. */
  pool: PoolView | null
  /** The panel is in its small corner shape, so drop the optional parts. */
  compact: boolean
  approvalMode: ApprovalMode
  onCycleApproval(): void
  onCompact(): void
  onQuota(): void
}): React.JSX.Element {
  const elapsed = stats.elapsedMs !== null ? duration(stats.elapsedMs) : null

  // While streaming, derive a live rate from what has arrived so far; once the
  // turn lands, show the rate the provider reported.
  const liveRate =
    streaming && stats.elapsedMs && stats.elapsedMs > 600
      ? (stats.liveTokens / (stats.elapsedMs / 1000)).toFixed(1)
      : null

  return (
    <footer className="status">
      {/*
        The model, which is the whole of what used to be a backend button and
        a tier name. It is still worth a permanent place: it is the one thing
        that decides what an answer costs and where the question goes.
      */}
      <span className={`status-model${ready ? '' : ' is-unready'}`} title={model}>
        {ready ? model : `${model} — no key`}
      </span>

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
      )}

      {/* Quota before context: one of them is a wall with a timer on it. */}
      {pool && !compact && <QuotaMeter pool={pool} onReport={onQuota} />}

      <ContextMeter usage={usage} onCompact={onCompact} />
    </footer>
  )
}

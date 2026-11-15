import type { ApprovalMode, ContextUsage } from '@shared/types'
import { MIDTASK_AT, SEND_AT, fullness } from '@shared/pressure'
import type { PoolView } from '@shared/pool'
import { keyCommandFor } from '../quota'
import type { ChatStats } from '../hooks/useChat'

/**
 * Elapsed and load times, which on a CPU-only machine and a 14B model can run
 * well past a minute. Seconds alone stopped being readable around "184.3s".
 */
/** A line break in a tooltip, built without an escape sequence. */
const LINE = String.fromCharCode(10)

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
 * How full the context window is. Turns amber at the percentage where a send
 * compacts first, and red at the one where even a result handed back by the
 * app itself stops to make room. Both come from @shared/pressure.
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
  /**
   * The conversation, against the room the conversation has.
   *
   * "why is the minimum compact thing 40%?" - because this was used over
   * limit, and roughly half of `used` is the instructions, which are re-sent
   * every turn and which this button cannot shrink by a single token. A
   * meter that reads 45% on a chat holding the word "hi", and that compacts
   * when you click it, is answering a different question from the one it is
   * asking you to act on. It starts at zero now. See `fullness`.
   */
  const pct = Math.min(100, fullness(usage.used, usage.limit, usage.instructions) * 100)
  /* The same two numbers the compaction uses, imported rather than typed
     again: a meter that turns amber at a different percentage from the one
     that acts is a meter that lies about what is about to happen. */
  const level = pct >= MIDTASK_AT * 100 ? 'is-critical' : pct >= SEND_AT * 100 ? 'is-warn' : ''

  return (
    <button
      type="button"
      className={`ctx ${level}`}
      onClick={onCompact}
      title={[
        `This conversation: ~${Math.max(0, usage.used - (usage.instructions ?? 0)).toLocaleString()} ` +
          `of the ${Math.max(0, usage.limit - (usage.instructions ?? 0)).toLocaleString()} tokens it has room for ` +
          `(${pct.toFixed(0)}%)${usage.estimated ? ', estimated' : ', counted by the provider'}`,
        /*
         * The whole window underneath, because the percentage is no longer
         * of it. The instructions are re-sent in full on every turn and this
         * button cannot shrink them by one token - which is why they are the
         * room that was taken out of the number rather than part of it.
         */
        usage.instructions
          ? `Instructions, re-sent every turn and not compactable: ~${usage.instructions.toLocaleString()}` +
            `${LINE}Whole window: ${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()}`
          : '',
        'Click to compact older turns (the instructions stay).'
      ]
        .filter(Boolean)
        .join(LINE)}
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
           hover rather than only in the full report. Named for the provider
           this model actually routes to: see keyCommandFor. */
        (pool.rejected ? `, ${pool.rejected} REFUSED — run ${keyCommandFor(pool.model)} check` : '') +
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
  reflect,
  onReflectOff,
  listening,
  onCycleApproval,
  onCompact,
  onQuota,
  onListening
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
  /**
   * Self-reflection is on: every finished task costs a review as well. Shown
   * while it is on, for the same reason as the meeting pill - a setting that
   * changes what each turn costs should not be invisible. Click to turn off.
   */
  reflect: boolean
  onReflectOff(): void
  /**
   * A meeting being transcribed, when one is. Words, or null.
   *
   * ON SCREEN BECAUSE IT IS INVISIBLE OTHERWISE, and that matters more
   * here than for anything else in this bar: while it is listening, every
   * message carries the transcript, so a session nobody can see is a
   * session silently changing what each turn costs and what the model is
   * answering from. The whole point of dropping the command arguments was
   * that nothing should have to be remembered; a thing you can see is the
   * other half of that.
   */
  listening: { words: number; live: boolean; level: number } | null
  onCycleApproval(): void
  onCompact(): void
  onQuota(): void
  /** Click the pill to stop, or to write the notes up. */
  onListening(): void
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

      {listening && (
        <button
          type="button"
          className={`listening${listening.live ? ' is-live' : ''}`}
          onClick={onListening}
          title={
            listening.live
              ? `Listening — ${
                  listening.words
                    ? `${listening.words} words so far`
                    : 'nothing transcribed yet; the bar shows what it can hear'
                }. Every message you send carries the transcript. Click to stop.`
              : `${listening.words} words of transcript, kept with this chat. ` +
                `Every message you send carries it. Click to write it up.`
          }
        >
          {listening.live ? 'listening' : 'transcript'}
          {/*
            What it can hear, while it is listening.

            An open microphone that shows nothing is a thing you have to take
            on faith, and faith is what a session reported as "it heard
            nothing but silence" cost an afternoon of. Dictation has had a
            meter since the beginning; this ran for hours with none. Three
            millimetres of bar answers the only question anyone has about a
            listening session without opening the log.
          */}
          {listening.live && (
            <span className="listening-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.max(0.02, listening.level)})` }} />
            </span>
          )}
        </button>
      )}

      <span className="spacer" />

      {reflect && (
        <button
          type="button"
          className="approval is-reflect"
          onClick={onReflectOff}
          title="Self-reflection: a mentor reviews each finished task. Click to turn off (/reflect off)."
        >
          reflect
        </button>
      )}

      {/* Never leave the user guessing what will run without them. */}
      <button
        type="button"
        className={`approval is-${approvalMode}`}
        onClick={onCycleApproval}
        title={APPROVAL[approvalMode].title}
      >
        {/*
          How much of the dot is filled in is how much runs without you:
          empty, half, solid. The three modes already differed by a word and
          a colour, and the word is 9.5px in the corner of the screen - this
          is the same fact in a shape, which is the part you can see without
          reading. Not the only signal, which is the point: Shift+Tab is easy
          to hit by accident, and what it changes should be noticeable.
        */}
        <span className="approval-dot" aria-hidden="true" />
        {APPROVAL[approvalMode].label}
      </button>

      {streaming ? (
        <span className="status-live">
          {elapsed && <span className="status-num">{elapsed}</span>}
          {/*
           * WAITING IS NOT THINKING, and the difference is worth one word.
           *
           * "it thinks a bit overly slowly... idk if its slowed down because
           * of wumpy's looking at my screen process, or stuff like that."
           * Measured the same morning: 2.4s to the first token at 10:28 and
           * 88s at 12:05, same build, same preamble, with the output rate
           * healthy either way - so the time is spent in the provider's
           * queue before a single word is generated, and Wumpy's look is
           * 1.2s of it.
           *
           * Nothing said so while it was happening. The load figure was
           * already in this bar, but only AFTER the turn, which is exactly
           * when nobody needs it any more.
           */}
          {stats.liveTokens === 0 && (
            <>
              <span className="status-sep">·</span>
              <span className="status-num is-waiting">waiting for the model</span>
            </>
          )}
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

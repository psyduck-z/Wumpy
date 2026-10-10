import { useEffect, useRef, useState } from 'react'
import { registerPending } from '../pending'
import { claimOnce, wasClaimed } from '../once'
import { liveOutput, onLive, forgetLive } from '../live'
import { runningPhase, tailLines } from '@shared/running'
import type { ShellKind, ShellResult } from '@shared/types'
import { arrowNavigate } from '../keyboard'

const SHELL_LABEL: Record<ShellKind, string> = {
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  bash: 'Bash'
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * The running clock, in whole seconds.
 *
 * Separate from duration() above, which reports a finished command and is
 * right to show tenths - 881ms against 1.2s is a real difference there. A
 * clock that ticks once a second should not be showing "47.0s"; it knows
 * the figure to the second and nothing finer.
 */
function clock(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * Splits the leading comment lines off a proposed command.
 *
 * The model is told to open every block with a `#` line saying why it wants to
 * run it. That line is the whole point of the approval card: "delete everything
 * under Downloads" and "check whether Ollama is installed" look similar as
 * shell syntax but are not remotely the same decision.
 */
function splitReason(raw: string): { reason: string | null; command: string } {
  const lines = raw.split('\n')
  const reason: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const m = /^(?:#+|::|REM\b)\s*(.*)$/i.exec(line)
    if (!m) break
    if (m[1]) reason.push(m[1])
  }
  const command = lines.slice(i).join('\n').trim()
  // A block that is only comments is not a command, and must not become one.
  // This said exactly that and then returned the comment text as the command,
  // so a half-written block ran `#` and `# Create text` as PowerShell. Both
  // "succeed" — a comment is valid PowerShell — so they looked like real,
  // silent successes rather than the nonsense they were.
  if (!command) return { reason: reason.join(' ') || null, command: '' }
  return { reason: reason.join(' ') || null, command }
}

/**
 * A command the model has proposed, with the Run button that is the actual
 * permission gate.
 *
 * Nothing executes until this button is pressed. The model only ever emits
 * text, so it cannot reach the shell on its own — and because both the reason
 * and the command are shown verbatim first, anything smuggled in through
 * something the model read is still visible before it runs.
 */
export function CommandCard({
  command: raw,
  shell,
  fallbackReason = null,
  complete = true,
  canAutoRun,
  messageId = '',
  onRun,
  onResult
}: {
  command: string
  shell: ShellKind
  /** Used when the block omits its `# why` line but the prose above explains it. */
  fallbackReason?: string | null
  /**
   * False while the message is still arriving.
   *
   * An unclosed fence renders as a code block, so this card exists from the
   * moment the opening ``` is revealed, holding however much of the command has
   * been written so far. Running then would run a truncated command.
   */
  complete?: boolean
  /**
   * Whether this particular command may still run unattended, asked of the app
   * rather than decided here: it is what stops an automatic mode from running
   * the same command on a loop.
   */
  canAutoRun?: (command: string, messageId: string) => boolean
  /** Which message proposed it; one message may run at most one command. */
  messageId?: string
  onRun(command: string, shell: ShellKind, runId?: string): Promise<ShellResult | null>
  /** `unattended` is false when a person pressed Run, which resets nothing. */
  onResult(result: ShellResult, unattended: boolean): void
}): React.JSX.Element {
  const parsed = splitReason(raw)
  const command = parsed.command
  const reason = parsed.reason ?? fallbackReason
  const [risk, setRisk] = useState<string | null>(null)
  // Null until the main process has judged it; the Run button waits for this.
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [auto, setAuto] = useState(false)
  /**
   * Whether the verdict has arrived.
   *
   * Without this the card drew Run and Skip for the moment the check was in
   * flight and then replaced them with "running automatically" - a pair of
   * buttons flashing up in an automatic mode, asking a question that had
   * already been answered.
   */
  const [judged, setJudged] = useState(false)
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  const [result, setResult] = useState<ShellResult | null>(null)
  const [showOutput, setShowOutput] = useState(true)

  useEffect(() => {
    if (!command) return
    let live = true
    void window.wumpy.shell.check({ command }).then((r) => {
      if (!live) return
      setRisk(r.risk)
      setAllowed(r.allowed)
      setAuto(r.auto)
      setJudged(true)
    })
    return () => {
      live = false
    }
  }, [command])

  // The verdict comes from the main process, so the mode cannot be widened
  // here; this only decides whether to press the button on the user's behalf.
  // Absent means "not eligible", not "no opinion": a message reopened from a
  // saved chat is handed no predicate, and must never run itself again.
  // Whether the mode would run this. Asking the app for permission is a claim
  // that spends the budget, so that happens in the effect below and never
  // during render, which React may run more than once for a single commit.
  const [refused, setRefused] = useState(false)
  const wouldRun = auto && complete && Boolean(command) && Boolean(canAutoRun)
  const unattended = wouldRun && !refused

  /**
   * Whether this command has already run, remembered outside React.
   *
   * It used to be a ref, and a ref dies with the component instance. Anything
   * that remounts the card - and appending the "Ran:" message to the
   * transcript does - handed it a fresh one, so a command that had already
   * run came back as an idle card offering Skip and Run. On accept-all that
   * is the mode visibly lying: the user asked for nothing to be asked, and
   * was asked anyway, about something already done.
   *
   * The command did not actually run twice, because the app's unattended slot
   * survives the remount. Only the card's memory of it was lost. This is the
   * same guard the link, write and search cards already use, keyed the same
   * way, and the comment in once.ts claiming CommandCard did not need it was
   * wrong for exactly this reason.
   */
  const ranKey = `run:${messageId}:${command}`
  const [alreadyRan] = useState(() => wasClaimed(ranKey))

  const ranOnce = useRef(false)
  useEffect(() => {
    if (!wouldRun || refused || allowed !== true) return
    if (state !== 'idle' || ranOnce.current || alreadyRan) return
    // Claimed synchronously: whatever else happens, nothing else may take this
    // slot, and this card may not take another.
    if (!canAutoRun!(command, messageId)) {
      setRefused(true)
      return
    }
    ranOnce.current = true
    void run(true)
  }, [wouldRun, refused, allowed, state])

  const waiting =
    state === 'idle' &&
    judged &&
    allowed === true &&
    complete &&
    Boolean(command) &&
    !unattended &&
    !alreadyRan

  // Only while it is actually waiting, so Ctrl+Enter always means the card the
  // user is looking at.
  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + command, {
      command,
      run: () => void run(false),
      skip: () => setState('cancelled')
    })
  }, [waiting, command, messageId])

  /**
   * How long the command has been going, ticking once a second.
   *
   * The card said "running…" and nothing else, for up to the ten-minute
   * ceiling. A winget install takes two or three minutes, during which the
   * only thing on screen is a word that never changes - indistinguishable
   * from frozen, and the install it was running had in fact worked.
   *
   * A clock cannot say how far along it is. It can say the app has not
   * died, which was the question being asked - and the live output below
   * answers the rest of it.
   */
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (state !== 'running' || startedAt === null) return
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [state, startedAt])

  /**
   * What the command has printed so far.
   *
   * A clock says the app has not died. This says what it is doing, which is
   * the question actually being asked - and for an installer it is genuinely
   * worth watching, because winget narrates: found it, downloading, verified
   * the hash, installing. Kept in a module rather than in state so that the
   * remount halfway through does not lose it.
   */
  const [live, setLive] = useState('')
  useEffect(() => {
    if (state !== 'running') return
    setLive(liveOutput(ranKey))
    return onLive(ranKey, () => setLive(liveOutput(ranKey)))
  }, [state, ranKey])

  const phase = runningPhase(command, live, elapsed)
  const lines = tailLines(live, 6)

  /** Pinned to the newest line, the way a terminal is. */
  const liveRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = liveRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live])

  const run = async (byItself = false): Promise<void> => {
    // Claimed before the command leaves, so a remount mid-run also knows.
    claimOnce(ranKey)
    setStartedAt(Date.now())
    setElapsed(0)
    setState('running')
    const res = await onRun(command, shell, ranKey)
    forgetLive(ranKey)
    if (!res) {
      // Null means the native confirmation was declined.
      setState('cancelled')
      return
    }
    setResult(res)
    setState('done')
    onResult(res, byItself)
  }

  const failed = result !== null && result.exitCode !== 0
  const output = result ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : ''

  /** The card itself, so the arrow keys can find its buttons. */
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      className={`cmd ${risk ? 'is-risky' : ''} ${failed ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <span className="cmd-shell">{SHELL_LABEL[shell]}</span>
        {risk && (
          <span className="cmd-risk" title={`This command ${risk}.`}>
            {risk}
          </span>
        )}
        <span className="spacer" />
        {state === 'idle' && allowed === true && unattended && (
          <span className="cmd-status">running automatically…</span>
        )}
        {state === 'idle' && (!complete || !command) && (
          <span className="cmd-status">still writing…</span>
        )}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('cancelled')}>
              Skip
            </button>
            <button
              type="button"
              className="cmd-run"
              onClick={() => void run(false)}
              title="Run (Ctrl+Enter)"
            >
              Run
            </button>
          </>
        )}
        {state === 'idle' && alreadyRan && <span className="cmd-status">already run</span>}
        {state === 'idle' && judged && allowed === false && complete && command && (
          <span className="cmd-status">commands are off — /shell on</span>
        )}
        {state === 'running' && (
          <span className="cmd-status is-running" role="status">
            {phase.verb}
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {elapsed > 0 && ` ${clock(elapsed)}`}
            {/* Said only once the wait is long enough to need explaining. An
                installer really does take this long, and saying so is the
                difference between waiting and giving up. */}
            {phase.note && ` · ${phase.note}`}
          </span>
        )}
        {state === 'cancelled' && <span className="cmd-status">skipped</span>}
        {state === 'done' && result && (
          <span className={`cmd-status ${failed ? 'is-failed' : 'is-ok'}`}>
            {result.timedOut ? 'timed out' : failed ? `exit ${result.exitCode}` : 'done'} ·{' '}
            {duration(result.durationMs)}
          </span>
        )}
      </div>

      {reason ? (
        <p className="cmd-reason">{reason}</p>
      ) : (
        <p className="cmd-reason is-missing">No reason given — read the command carefully.</p>
      )}

      <pre className="cmd-body">{command || raw.trim()}</pre>

      {state === 'running' && (
        <div className="cmd-live">
          <pre ref={liveRef} aria-live="off">
            {lines.join(String.fromCharCode(10))}
            {/* A terminal caret, so an installer that has gone quiet for
                thirty seconds still looks like a terminal waiting rather
                than a window that has stopped. */}
            <span className="cmd-caret">&#9608;</span>
          </pre>
          {lines.length === 0 && <p className="cmd-live-empty">nothing printed yet</p>}
        </div>
      )}

      {result && (
        <div className="cmd-output">
          <button type="button" className="cmd-toggle" onClick={() => setShowOutput((v) => !v)}>
            <span className={`caret-glyph ${showOutput ? 'is-open' : ''}`}>&#9656;</span>
            {output ? `${showOutput ? 'Hide' : 'Show'} output` : 'No output'}
            {result.truncated && ' (truncated)'}
          </button>
          {showOutput && output && <pre>{output}</pre>}
        </div>
      )}
    </div>
  )
}

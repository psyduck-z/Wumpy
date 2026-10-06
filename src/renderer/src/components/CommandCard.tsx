import { useEffect, useState } from 'react'
import type { ShellKind, ShellResult } from '@shared/types'

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
    const m = /^(?:#+|::|REM)\s*(.*)$/i.exec(line)
    if (!m) break
    if (m[1]) reason.push(m[1])
  }
  const command = lines.slice(i).join('\n').trim()
  // A block that was only comments is not a command.
  if (!command) return { reason: null, command: raw.trim() }
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
  onRun,
  onResult
}: {
  command: string
  shell: ShellKind
  onRun(command: string, shell: ShellKind): Promise<ShellResult | null>
  onResult(result: ShellResult): void
}): React.JSX.Element {
  const { reason, command } = splitReason(raw)
  const [risk, setRisk] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  const [result, setResult] = useState<ShellResult | null>(null)
  const [showOutput, setShowOutput] = useState(true)

  useEffect(() => {
    let live = true
    void window.wumpy.shell.risk(command).then((r) => {
      if (live) setRisk(r)
    })
    return () => {
      live = false
    }
  }, [command])

  const run = async (): Promise<void> => {
    setState('running')
    const res = await onRun(command, shell)
    if (!res) {
      // Null means the native confirmation was declined.
      setState('cancelled')
      return
    }
    setResult(res)
    setState('done')
    onResult(res)
  }

  const failed = result !== null && result.exitCode !== 0
  const output = result ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : ''

  return (
    <div className={`cmd ${risk ? 'is-risky' : ''} ${failed ? 'is-failed' : ''}`}>
      <div className="cmd-head">
        <span className="cmd-shell">{SHELL_LABEL[shell]}</span>
        {risk && <span className="cmd-risk" title={`This command ${risk}.`}>{risk}</span>}
        <span className="spacer" />
        {state === 'idle' && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('cancelled')}>
              Skip
            </button>
            <button type="button" className="cmd-run" onClick={() => void run()}>
              Run
            </button>
          </>
        )}
        {state === 'running' && <span className="cmd-status">running…</span>}
        {state === 'cancelled' && <span className="cmd-status">skipped</span>}
        {state === 'done' && result && (
          <span className={`cmd-status ${failed ? 'is-failed' : 'is-ok'}`}>
            {result.timedOut
              ? 'timed out'
              : failed
                ? `exit ${result.exitCode}`
                : 'done'}{' '}
            · {duration(result.durationMs)}
          </span>
        )}
      </div>

      {reason ? (
        <p className="cmd-reason">{reason}</p>
      ) : (
        <p className="cmd-reason is-missing">No reason given — read the command carefully.</p>
      )}

      <pre className="cmd-body">{command}</pre>

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

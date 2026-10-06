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
 * A command the model has proposed, with the Run button that is the actual
 * permission gate.
 *
 * Nothing executes until this button is pressed. The model only ever emits
 * text, so it cannot reach the shell on its own — and because the command is
 * shown verbatim before it runs, a command smuggled in through something the
 * model read is still visible here before anything happens.
 */
export function CommandCard({
  command,
  shell,
  onRun,
  onResult
}: {
  command: string
  shell: ShellKind
  onRun(command: string, shell: ShellKind): Promise<ShellResult | null>
  onResult(result: ShellResult): void
}): React.JSX.Element {
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

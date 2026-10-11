import { useEffect, useRef, useState } from 'react'
import type { Attachment, DesktopResult } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { describe, readPlan } from '@shared/steps'
import type { LinkApproval } from '@shared/links'

/**
 * The model asking to click and type on the real desktop.
 *
 * This is the loudest thing Wumpy can propose, so the card shows the whole
 * plan as sentences before any of it happens - "Click at 420, 18", "Type
 * \"Stanley\"" - rather than the block's own shorthand. The user asked for
 * this capability and runs it on accept-all, where the card will not wait
 * for them; the list is there so that what scrolled past is readable
 * afterwards, which on accept-all is the only review there is.
 *
 * The parse here is for display only. Main parses the block again and its
 * copy is the one that acts, because a renderer is reachable from a model's
 * output and a main process is not.
 */
export function DoCard({
  body,
  complete = true,
  mode = 'manual',
  messageId = '',
  fallbackReason,
  onRun,
  onDone
}: {
  body: string
  complete?: boolean
  mode?: LinkApproval
  messageId?: string
  fallbackReason?: string | null
  onRun(body: string): Promise<DesktopResult>
  onDone(result: DesktopResult, after: Attachment | null): void
}): React.JSX.Element {
  const plan = readPlan(body)
  const reason = plan.reason || (fallbackReason ?? '')

  const [state, setState] = useState<'idle' | 'working' | 'done' | 'skipped'>('idle')
  const [result, setResult] = useState<DesktopResult | null>(null)

  const go = async (): Promise<void> => {
    setState('working')
    try {
      const got = await onRun(body)
      setResult(got)
      setState('done')
      onDone(got, got.after)
    } catch (err) {
      setResult({
        ran: [],
        refused: err instanceof Error ? err.message : String(err),
        problems: [],
        after: null
      })
      setState('done')
    }
  }

  /* Accept-all runs it, like everything else. The user was explicit twice. */
  const itself = complete && mode === 'all'
  const started = useRef(false)
  useEffect(() => {
    if (!itself || state !== 'idle' || started.current) return
    if (!claimOnce(`do:${messageId}`)) return
    started.current = true
    void go()
  }, [itself, state, messageId])

  const waiting = state === 'idle' && complete && !itself

  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + 'do', {
      command: 'Control the screen',
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId])

  const cardRef = useRef<HTMLDivElement>(null)
  const failed = Boolean(result?.refused) || Boolean(result?.ran.some((r) => !r.ok))

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      className={`cmd desktop ${failed ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <span className="cmd-shell">Your screen</span>
        <span className="cmd-risk" title="This moves the pointer and presses keys on your desktop.">
          clicks and types
        </span>
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              No
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              Do it
            </button>
          </>
        )}
        {state === 'idle' && itself && <span className="cmd-status">running automatically…</span>}
        {state === 'working' && <span className="cmd-status">on your screen…</span>}
        {state === 'skipped' && <span className="cmd-status">declined</span>}
        {state === 'done' && !result?.refused && (
          <span className="cmd-status">
            {result?.ran.filter((r) => r.ok).length ?? 0}/{result?.ran.length ?? 0} done
          </span>
        )}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}

      {/* The plan in full, before it happens and still there after. */}
      <ol className="steps">
        {plan.steps.map((step, i) => {
          const outcome = result?.ran[i]
          return (
            <li
              key={i}
              className={outcome ? (outcome.ok ? 'is-done' : 'is-failed') : ''}
              title={outcome?.detail}
            >
              {describe(step)}
            </li>
          )
        })}
      </ol>

      {plan.problems.length > 0 && (
        <div className="cmd-output">{plan.problems.join(String.fromCharCode(10))}</div>
      )}
      {result?.refused && <div className="cmd-output">{result.refused}</div>}
      {result?.ran.some((r) => !r.ok) && (
        <div className="cmd-output">
          {result.ran.find((r) => !r.ok)?.detail}
          {String.fromCharCode(10)}Stopped there, so nothing after it ran.
        </div>
      )}
    </div>
  )
}

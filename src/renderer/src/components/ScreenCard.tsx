import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'

/**
 * The model asking to look at the screen, and the button that lets it.
 *
 * It cannot look by itself. It proposes a `wumpy-screen` block with a line
 * saying why, that becomes this card, and nothing is photographed until the
 * button is pressed. The picture then appears in the transcript as an
 * attachment on the user's own turn, so what was sent is never in doubt.
 *
 * THIS CARD ALWAYS ASKS, including on accept-all.
 *
 * That is a deliberate exception and the only one of its kind here. Every
 * other proposal can be read before it runs: a command is text, a search is
 * a query, a file write names its path. A screenshot is the one proposal
 * whose CONTENTS are unknown until after it has happened - whatever is on
 * the screen at that instant, which could be a password manager, a private
 * message or someone else's data. Accept-all is the user saying yes to
 * things they can see; it cannot be consent to something nobody has looked
 * at yet. The app already has precedent for this: a severely destructive
 * command raises a dialog whatever the mode.
 */
export function ScreenCard({
  body,
  complete = true,
  messageId = '',
  fallbackReason,
  onCapture,
  onCaptured
}: {
  /** The block's contents: a `# why` line, and nothing else to run. */
  body: string
  /** False while the message is still arriving. */
  complete?: boolean
  messageId?: string
  /** The sentence before the fence, when the model omitted the # line. */
  fallbackReason?: string | null
  onCapture(): Promise<Attachment>
  onCaptured(shot: Attachment): void
}): React.JSX.Element {
  const reason =
    body
      .split(String.fromCharCode(10))
      .filter((l) => l.trim().startsWith('#'))
      .map((l) => l.replace(/^\s*#+\s*/, ''))
      .join(' ')
      .trim() || (fallbackReason ?? '')

  const [state, setState] = useState<'idle' | 'working' | 'done' | 'skipped'>('idle')
  const [shot, setShot] = useState<Attachment | null>(null)
  const [error, setError] = useState<string | null>(null)

  const go = async (): Promise<void> => {
    setState('working')
    try {
      const got = await onCapture()
      setShot(got)
      setState('done')
      onCaptured(got)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('done')
    }
  }

  const waiting = state === 'idle' && complete

  /** Ctrl+Enter reaches this card too, like every other pending proposal. */
  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + 'screen', {
      command: 'Show the screen',
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId])

  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      className={`cmd screen ${error ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <span className="cmd-shell">Your screen</span>
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              No
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              Show screen
            </button>
          </>
        )}
        {state === 'working' && <span className="cmd-status">capturing…</span>}
        {state === 'skipped' && <span className="cmd-status">declined</span>}
        {state === 'done' && shot && (
          <span className="cmd-status">
            {shot.width}×{shot.height} sent
          </span>
        )}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}
      {waiting && (
        <p className="cmd-body screen-warning">
          This takes a picture of your screen and sends it to the model. Close anything
          you would rather it did not see.
        </p>
      )}
      {error && <div className="cmd-output">{error}</div>}
    </div>
  )
}

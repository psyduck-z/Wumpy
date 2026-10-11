import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import type { LinkApproval } from '@shared/links'

/**
 * The model asking to look at the screen, and the button that lets it.
 *
 * It cannot look by itself. It proposes a `wumpy-screen` block with a line
 * saying why, that becomes this card, and nothing is photographed until the
 * button is pressed. The picture then appears in the transcript as an
 * attachment on the user's own turn, so what was sent is never in doubt.
 *
 * On accept-all it captures by itself, like everything else.
 *
 * This card used to be an exception, on the reasoning that a screenshot is
 * the one proposal whose CONTENTS are unknown until after the fact - whatever
 * happens to be on screen, which could be a password manager or someone
 * else's data - so accept-all could not really be consent to it.
 *
 * The user's answer was that accept-all means accept everything, screen
 * included, and that is their call to make: it is their screen, they turned
 * the mode on deliberately, and a tool that keeps asking after being told
 * not to is just a worse tool. The reasoning is kept here rather than
 * deleted, because it is the argument for turning the mode off, not an
 * argument for overriding it.
 */
export function ScreenCard({
  body,
  complete = true,
  mode = 'manual',
  messageId = '',
  fallbackReason,
  onCapture,
  onCaptured
}: {
  /** The block's contents: a `# why` line, and nothing else to run. */
  body: string
  /** False while the message is still arriving. */
  complete?: boolean
  /** Only 'all' captures unasked. 'auto' is for things that change nothing. */
  mode?: LinkApproval
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

  /**
   * Accept-all, and only accept-all.
   *
   * Not 'auto': that mode is for proposals that change nothing on the
   * machine, and a photograph of the screen leaving for a model is not
   * nothing. Someone on 'auto' has asked for the harmless things to proceed,
   * which is a different request from this one.
   */
  const itself = complete && mode === 'all'
  const taken = useRef(false)
  useEffect(() => {
    if (!itself || state !== 'idle' || taken.current) return
    /* Claimed outside React so a remount cannot take a second photograph. */
    if (!claimOnce(`screen:${messageId}`)) return
    taken.current = true
    void go()
  }, [itself, state, messageId])

  const waiting = state === 'idle' && complete && !itself

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
        {state === 'idle' && itself && <span className="cmd-status">capturing automatically…</span>}
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

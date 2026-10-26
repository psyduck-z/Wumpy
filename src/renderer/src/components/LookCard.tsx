import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { readLookRequest } from '@shared/look'
import { sizeLabel } from '@shared/attach'
import type { LinkApproval } from '@shared/links'
import { KIND_FAMILY } from '../kinds'
import { KindMark } from './KindMark'

/**
 * The model asking to open a picture that is already on the disk.
 *
 * The twin of ScreenCard, and the same contract: it cannot open anything by
 * itself, the block becomes this card, and nothing is read until the button
 * is pressed. The picture then appears on the user's own turn, so what was
 * sent is never in doubt.
 *
 * THE PATH IS THE WHOLE POINT OF THE CARD, and it is shown in the words the
 * model wrote rather than tidied. Reading a file changes nothing, so the
 * usual argument for approval does not apply here - the one that does is
 * that this read SENDS what it reads, to someone else's server, on a path
 * the model chose. The only person who can say whether that is the file
 * they meant is the one reading the path, so the path is the largest thing
 * on the card.
 *
 * On accept-all it opens by itself, like everything else. The user settled
 * that for the screen, which is the stronger case: whatever happens to be
 * on screen is less predictable than a file they just named.
 */
export function LookCard({
  body,
  complete = true,
  mode = 'manual',
  messageId = '',
  fallbackReason,
  onLook,
  onOpened
}: {
  /** The block's contents: a `# why` line and one path. */
  body: string
  /** False while the message is still arriving. */
  complete?: boolean
  mode?: LinkApproval
  messageId?: string
  /** The sentence before the fence, when the model omitted the # line. */
  fallbackReason?: string | null
  onLook(path: string): Promise<{ ok: boolean; file?: Attachment; path: string; why: string }>
  onOpened(file: Attachment, why: string): void
}): React.JSX.Element {
  const request = readLookRequest(body)
  const reason = request.why || fallbackReason || ''

  const [state, setState] = useState<'idle' | 'working' | 'done' | 'skipped'>('idle')
  const [file, setFile] = useState<Attachment | null>(null)
  const [error, setError] = useState<string | null>(null)

  const go = async (): Promise<void> => {
    setState('working')
    try {
      const got = await onLook(request.path)
      if (!got.ok || !got.file) {
        setError(got.why || 'Could not open that file.')
        setState('done')
        return
      }
      setFile(got.file)
      setState('done')
      onOpened(got.file, reason)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('done')
    }
  }

  /* Accept-all only, for the same reason the screen card gives: 'auto' is
     for proposals that change nothing, and bytes leaving the machine is
     not nothing. */
  const itself = complete && mode === 'all' && Boolean(request.path)
  const taken = useRef(false)
  useEffect(() => {
    if (!itself || state !== 'idle' || taken.current) return
    /* Claimed outside React so a remount cannot send the file twice. */
    if (!claimOnce(`look:${messageId}`)) return
    taken.current = true
    void go()
  }, [itself, state, messageId])

  const waiting = state === 'idle' && complete && !itself && Boolean(request.path)

  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + 'look', {
      command: `Open ${request.path}`,
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId, request.path])

  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      data-family={KIND_FAMILY.look}
      className={`cmd look ${error ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <KindMark kind="look" />
        <span className="cmd-shell">Open a picture</span>
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              No
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              Open it
            </button>
          </>
        )}
        {state === 'idle' && itself && <span className="cmd-status">opening automatically…</span>}
        {state === 'working' && <span className="cmd-status">reading…</span>}
        {state === 'skipped' && <span className="cmd-status">declined</span>}
        {state === 'done' && file && (
          <span className="cmd-status">{sizeLabel(file.bytes)} sent</span>
        )}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}
      {/* The path, before anything is read, because it is what is being
          approved. Shown even once it has been sent: the record of what
          went is more use than the button that sent it. */}
      {request.path ? (
        <pre className="cmd-body">{request.path}</pre>
      ) : (
        <p className="cmd-body">No file was named in that block.</p>
      )}
      {/* A model that lists several has had two quietly dropped unless this
          says so. */}
      {request.extra > 0 && (
        <p className="cmd-reason">
          {request.extra} other path{request.extra === 1 ? '' : 's'} in that block were ignored —
          one file at a time.
        </p>
      )}
      {error && <div className="cmd-output">{error}</div>}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { readAppProposal } from '../commands'
import type { LinkApproval } from '@shared/links'
import { KIND_FAMILY } from '../kinds'
import { KindMark } from './KindMark'

/**
 * The model asking to run one of Wumpy's own commands.
 *
 * It could only ever answer with the command as a button - "reply with only
 * the command: /rename, /new..." - and the button stopped at the ones that
 * could not hurt, so "delete this chat" got an explanation instead of a
 * deleted chat. Now it proposes the command in a `wumpy-app` block and this
 * card asks, like every other proposal: Run or No, Ctrl+Enter, and out loud
 * in the earbuds ("Can I delete this chat? Say yes or no.").
 *
 * The command runs as if typed - except that a delete runs as already
 * confirmed, because this card WAS the confirmation.
 *
 * On accept-all only the harmless ones go by themselves (see
 * readAppProposal). Deleting a chat or quitting always asks: accept-all is
 * consent to the model working, not to it tidying away the conversation.
 */
export function AppCard({
  body,
  complete = true,
  mode = 'manual',
  messageId = '',
  onRun
}: {
  body: string
  complete?: boolean
  mode?: LinkApproval
  messageId?: string
  /** Runs the command line as approved. */
  onRun(line: string): void
}): React.JSX.Element {
  const proposal = readAppProposal(body)
  const [state, setState] = useState<'idle' | 'done' | 'skipped'>('idle')

  const go = (): void => {
    if (!proposal || proposal.refused) return
    setState('done')
    onRun(proposal.line)
  }

  const itself = complete && mode === 'all' && !!proposal && !proposal.refused && proposal.harmless
  const started = useRef(false)
  useEffect(() => {
    if (!itself || state !== 'idle' || started.current) return
    if (!claimOnce(`app:${messageId}:${proposal?.line}`)) return
    started.current = true
    go()
  }, [itself, state, messageId])

  const waiting = state === 'idle' && complete && !itself && !!proposal && !proposal.refused

  useEffect(() => {
    if (!waiting || !proposal) return
    const said = proposal.reason.replace(/[.!?]+$/, '')
    return registerPending(messageId + 'app' + proposal.line, {
      command: proposal.line,
      // "Can I delete this chat?" - the # line reads as the question.
      spoken: said.charAt(0).toLowerCase() + said.slice(1),
      run: go,
      skip: () => setState('skipped')
    })
  }, [waiting, messageId, proposal?.line, proposal?.reason])

  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      data-family={KIND_FAMILY.app}
      className={`cmd app ${proposal?.refused ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <KindMark kind="app" />
        <span className="cmd-shell">Wumpy</span>
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              No
            </button>
            <button type="button" className="cmd-run" onClick={go}>
              Run
            </button>
          </>
        )}
        {state === 'idle' && itself && <span className="cmd-status">running…</span>}
        {state === 'done' && <span className="cmd-status">done</span>}
        {state === 'skipped' && <span className="cmd-status">declined</span>}
      </div>
      {proposal && <p className="cmd-reason">{proposal.reason}</p>}
      {proposal && <pre className="cmd-body">{proposal.line}</pre>}
      {proposal?.refused && <div className="cmd-output">{proposal.refused}</div>}
      {!proposal && complete && <div className="cmd-output">No command in this block.</div>}
    </div>
  )
}

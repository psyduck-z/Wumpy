import { useEffect, useRef, useState } from 'react'
import { readWriteRequest } from '@shared/writefile'
import type { WriteResult, WriteTarget } from '@shared/types'

/**
 * A file the model wants to create, and the button that allows it.
 *
 * Gated like a command, because it is one: writing a file changes the machine.
 * What it is not is a shell command, which is the whole reason this card exists -
 * the content below goes to disk exactly as written, with no quoting layer in
 * between to misread a brace or eat a dollar sign.
 *
 * The card leads on the resolved path rather than the one in the block, because
 * `~/Downloads/x.py` and `$HOME\Downloads\x.py` and `../../x.py` all look
 * reasonable and only one of them says where the file actually goes.
 */
export function WriteCard({
  request: raw,
  complete = true,
  autoWrite,
  onCheck,
  onWrite,
  onWritten,
  messageId
}: {
  request: string
  /** False while the message is still arriving and the file half-written. */
  complete?: boolean
  /** True when the user has turned on accept-all. */
  autoWrite: boolean
  onCheck(path: string): Promise<WriteTarget>
  onWrite(path: string, content: string): Promise<WriteResult>
  onWritten(result: WriteResult, messageId: string): void
  messageId: string
}): React.JSX.Element {
  const { reason, path, content } = readWriteRequest(raw)

  const [target, setTarget] = useState<WriteTarget | null>(null)
  const [state, setState] = useState<'idle' | 'writing' | 'done' | 'skipped' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const written = useRef(false)

  // Where it would land. Only once the block has closed, because a half-typed
  // path is a different path and checking it would show the user a refusal for
  // something the model had not finished saying.
  useEffect(() => {
    if (!complete || !path) return
    let live = true
    void onCheck(path).then((t) => {
      if (live) setTarget(t)
    })
    return () => {
      live = false
    }
  }, [complete, path])

  const go = async (): Promise<void> => {
    if (written.current || !path) return
    written.current = true
    setState('writing')
    const result = await onWrite(path, content)
    if (result.written) {
      setState('done')
    } else {
      setState('failed')
      setError(result.error ?? 'Could not write it.')
    }
    onWritten(result, messageId)
  }

  // Accept-all writes it without asking, once the destination has checked out.
  useEffect(() => {
    if (!autoWrite || !target?.ok || state !== 'idle' || written.current) return
    void go()
  }, [autoWrite, target, state])

  const lines = content ? content.split('\n').length : 0
  const bytes = new TextEncoder().encode(content).length
  const waiting = state === 'idle' && complete && target?.ok && !autoWrite

  return (
    <div className={`cmd write ${state === 'failed' || target?.ok === false ? 'is-failed' : ''}`}>
      <div className="cmd-head">
        <span className="cmd-shell">{target?.exists ? 'Replace file' : 'New file'}</span>
        <span className="spacer" />
        {state === 'idle' && !complete && <span className="cmd-status">still writing…</span>}
        {state === 'idle' && complete && !target && <span className="cmd-status">checking…</span>}
        {waiting && (
          <>
            <button type="button" className="cmd-skip" onClick={() => setState('skipped')}>
              Skip
            </button>
            <button type="button" className="cmd-run" onClick={() => void go()}>
              {target?.exists ? 'Replace' : 'Create'}
            </button>
          </>
        )}
        {state === 'writing' && <span className="cmd-status">writing…</span>}
        {state === 'done' && <span className="cmd-status">saved</span>}
        {state === 'skipped' && <span className="cmd-status">skipped</span>}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}

      <p className="write-path" title={target?.path || path || ''}>
        {target?.path || path || 'no path given'}
      </p>

      {target && !target.ok && <p className="write-refused">{target.why}</p>}
      {error && <p className="write-refused">{error}</p>}

      {/*
        Collapsed by default. A script is usually longer than the panel is tall,
        and what matters before approving is where it goes and how big it is -
        the content is there to be checked, not to be scrolled past every time.
      */}
      {content && (
        <>
          <button type="button" className="write-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} contents · {lines} line{lines === 1 ? '' : 's'} ·{' '}
            {bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`}
            {target?.exists && !open ? ' · replaces what is there' : ''}
          </button>
          {open && <pre className="cmd-body write-body">{content}</pre>}
        </>
      )}
    </div>
  )
}

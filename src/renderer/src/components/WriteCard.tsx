import { useEffect, useRef, useState } from 'react'
import { readWriteRequest } from '@shared/writefile'
import type { WriteResult, WriteTarget } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { registerPending } from '../pending'
import { claimOnce } from '../once'
import { KIND_FAMILY } from '../kinds'
import { KindMark } from './KindMark'

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
  messageId,
  earlier = false
}: {
  request: string
  /** False while the message is still arriving and the file half-written. */
  complete?: boolean
  /** True when the user has turned on accept-all. */
  autoWrite: boolean
  onCheck(path: string, content?: string): Promise<WriteTarget>
  onWrite(path: string, content: string): Promise<WriteResult>
  onWritten(result: WriteResult, messageId: string, content?: string): void
  messageId: string
  /**
   * In a message from before this session - a reopened chat, a restart.
   * An agent's file is held only while Wumpy runs, so its write card,
   * re-drawn after a restart, went red - "There is no file from agent-3 to
   * save" - over a file that had been saved fine.
   */
  earlier?: boolean
}): React.JSX.Element {
  const { reason, path, content: written_, from } = readWriteRequest(raw)
  /*
   * A file a background agent wrote, saved from its report as it is rather
   * than retyped by the model: `from: agent-7`. Until it arrives there is
   * nothing to write; if the agent has none, the card says so.
   */
  const [fromFile, setFromFile] = useState<string | null | undefined>(from ? undefined : null)
  useEffect(() => {
    if (!from || !complete) return
    let live = true
    void window.wumpy.agents
      .file(from)
      .then((text) => {
        if (live) setFromFile(text)
      })
      .catch(() => {
        if (live) setFromFile(null)
      })
    return () => {
      live = false
    }
  }, [from, complete])
  /* The card is mounted while the block streams in, before its `from:` line
     has arrived - so it started as "no file", and showed a red "There is no
     file from agent-7" until the file came. Waiting, once there is a from. */
  useEffect(() => {
    if (from) setFromFile((was) => (was === null ? undefined : was))
  }, [from])
  const content = from ? (fromFile ?? '') : written_
  const missingFrom = Boolean(from) && fromFile === null

  const [target, setTarget] = useState<WriteTarget | null>(null)
  const [state, setState] = useState<'idle' | 'writing' | 'done' | 'skipped' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const written = useRef(false)

  // Where it would land. Only once the block has closed, because a half-typed
  // path is a different path and checking it would show the user a refusal for
  // something the model had not finished saying.
  useEffect(() => {
    if (!complete || !path || (from && fromFile === undefined)) return
    let live = true
    void onCheck(path, earlier ? content : undefined).then((t) => {
      if (live) setTarget(missingFrom && !earlier ? { ...t, ok: false, why: `There is no file from ${from} to save: its report held none.` } : t)
    })
    return () => {
      live = false
    }
  }, [complete, path, fromFile])

  const go = async (): Promise<void> => {
    // Claimed outside React, so a remount cannot hand this card a fresh ref
    // and write the file a second time.
    if (!path) return
    if (!claimOnce(`write:${messageId}:${target?.path ?? path}`)) return
    written.current = true
    setState('writing')
    const result = await onWrite(path, content)
    if (result.written) {
      setState('done')
      /* The agent's card takes the saved file's name. */
      if (from) void window.wumpy.agents.saved(from, result.path).catch(() => {})
    } else {
      setState('failed')
      setError(result.error ?? 'Could not write it.')
    }
    onWritten(result, messageId, content)
  }

  // Accept-all writes it without asking, once the destination has checked out.
  useEffect(() => {
    if (!autoWrite || !target?.ok || state !== 'idle' || written.current || missingFrom) return
    void go()
  }, [autoWrite, target, state])

  const lines = content ? content.split('\n').length : 0
  const bytes = new TextEncoder().encode(content).length
  /* Never offered with nothing to write: an earlier agent's file, gone. */
  /* An earlier session's file, there already word for word: saved. */
  const already = earlier && target?.same === true
  const waiting = state === 'idle' && complete && target?.ok && !autoWrite && !missingFrom && !already

  /**
   * Registered so Ctrl+Enter reaches this too.
   *
   * Commands could always be approved from the keyboard and these could not,
   * which made the shortcut a half-truth: the hands stayed put for one kind
   * of proposal and went to the mouse for the other two.
   */
  useEffect(() => {
    if (!waiting) return
    return registerPending(messageId + (target?.path ?? path ?? 'a file'), {
      command: target?.path ?? path ?? 'a file',
      spoken: `write ${(target?.path ?? path ?? 'a file').split(/[\\/]/).pop()}`,
      run: () => void go(),
      skip: () => setState('skipped')
    })
  }, [waiting, messageId])

  /** The card itself, so the arrow keys can find its buttons. */
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={cardRef}
      onKeyDown={(e) => {
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
      data-family={KIND_FAMILY.write}
      className={`cmd write ${state === 'failed' || target?.ok === false ? 'is-failed' : ''}`}
    >
      <div className="cmd-head">
        <KindMark kind="write" />
        {/* Neither until it is known: "New file" turning into "Replace file"
            a moment later was a flicker on every card for a file already there. */}
        <span className="cmd-shell">{target ? (target.exists ? 'Replace file' : 'New file') : 'File'}</span>
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
        {(state === 'done' || (state === 'idle' && already)) && <span className="cmd-status">saved</span>}
        {state === 'skipped' && <span className="cmd-status">skipped</span>}
      </div>

      {reason && <p className="cmd-reason">{reason}</p>}

      <p className="write-path" title={target?.path || path || ''}>
        {target?.path || path || 'no path given'}
      </p>

      {target && !target.ok && <p className="write-refused">{target.why}</p>}
      {missingFrom && earlier && <p className="cmd-reason">From an agent in an earlier session: its file is no longer held here. If it was saved then, it is on disk.</p>}
      {error && <p className="write-refused">{error}</p>}

      {/*
        Collapsed by default. A script is usually longer than the panel is tall,
        and what matters before approving is where it goes and how big it is -
        the content is there to be checked, not to be scrolled past every time.
      */}
      {content && (
        <>
          <button type="button" className="write-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} contents{from ? ` · as ${from.replace('-', ' ')} wrote it` : ''} · {lines} line{lines === 1 ? '' : 's'} ·{' '}
            {bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`}
            {target?.exists && !open ? ' · replaces what is there' : ''}
          </button>
          {open && <pre className="cmd-body write-body">{content}</pre>}
        </>
      )}
    </div>
  )
}

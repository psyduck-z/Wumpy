import { useEffect, useState } from 'react'
import { agentAsks, monitorAsks } from '@shared/agents'
import { agentFor, monitorFor, useAgentState } from '../agentstate'
import { KindMark } from './KindMark'

/**
 * A background agent, in the answer that started it: what it is doing, the
 * steps it took, and its report once there is one.
 *
 * Nothing to approve: it runs only what the approval mode would run without
 * a click. Stop is there for an agent that is not worth its minute.
 */
const BT = String.fromCharCode(96).repeat(3)

function since(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const STATUS: Record<string, string> = {
  queued: 'waiting for a key',
  working: 'working',
  reviewing: 'being reviewed',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

export function AgentCard({
  body,
  messageId,
  complete
}: {
  body: string
  messageId: string
  complete: boolean
}): React.JSX.Element {
  const ask = agentAsks(`${BT}wumpy-agent\n${body}${BT}`)[0]
  const { agents } = useAgentState()
  const agent = ask ? agentFor(agents, messageId, ask.title) : undefined
  const [open, setOpen] = useState<'none' | 'brief' | 'report'>('none')
  const live = agent && (agent.status === 'queued' || agent.status === 'working' || agent.status === 'reviewing')

  /* The clock ticks while it works, and only then. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const title = ask?.title ?? body.split('\n')[0].replace(/^#+\s*/, '')
  return (
    <div data-family="runs" className={`cmd agent-card ${agent?.status === 'failed' ? 'is-failed' : ''}`}>
      <div className="cmd-head">
        <KindMark kind="run" />
        <span className="cmd-shell">{agent ? `Agent ${agent.number}` : 'Agent'}</span>
        <span className={`cmd-status ${agent?.status === 'done' ? 'is-ok' : agent?.status === 'failed' ? 'is-failed' : ''}`}>
          {agent
            ? `${STATUS[agent.status]}${agent.review ? ` · ${agent.review}` : ''} · ${since(agent.startedAt, agent.endedAt ?? now)}`
            : complete
              ? 'not running'
              : 'still writing…'}
        </span>
        <span className="spacer" />
        {live && (
          <button type="button" className="cmd-skip" onClick={() => void window.wumpy.agents.stop(agent.id)}>
            Stop
          </button>
        )}
      </div>
      <p className="cmd-reason">{title}</p>
      {agent && live && <p className="agent-doing">{agent.doing}</p>}
      {agent && agent.status === 'failed' && <p className="agent-doing">{agent.doing}</p>}
      {agent && agent.steps.length > 0 && (
        <ol className="agent-steps">
          {agent.steps.map((s, i) => (
            <li key={i} className={s.ok ? '' : 'is-refused'}>
              {s.kind === 'page' ? (
                s.what
              ) : (
                <>
                  {s.kind === 'run' ? 'ran' : 'searched'} <code>{s.what}</code>
                  {s.ok ? '' : ' - not run or failed'}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="agent-toggles">
        <button type="button" className="cmd-toggle" onClick={() => setOpen(open === 'brief' ? 'none' : 'brief')}>
          {open === 'brief' ? 'Hide the brief' : 'The brief'}
        </button>
        {agent?.report && (
          <button type="button" className="cmd-toggle" onClick={() => setOpen(open === 'report' ? 'none' : 'report')}>
            {open === 'report' ? 'Hide the report' : 'The report'}
          </button>
        )}
      </div>
      {open === 'brief' && <pre className="cmd-body agent-text">{ask?.brief ?? body}</pre>}
      {open === 'report' && agent?.report && <pre className="cmd-body agent-text">{agent.report}</pre>}
    </div>
  )
}

/** A monitor: which agents it waits on, and the note the chat left itself. */
export function MonitorCard({ body, messageId }: { body: string; messageId: string }): React.JSX.Element {
  const ask = monitorAsks(`${BT}wumpy-monitor\n${body}${BT}`)[0]
  const { monitors } = useAgentState()
  const monitor = ask ? monitorFor(monitors, messageId, ask.note) : undefined
  const which = monitor?.agents.length
    ? `agent${monitor.agents.length === 1 ? '' : 's'} ${monitor.agents.join(', ')}`
    : 'its agents'
  return (
    <div className="agent-monitor">
      <span className="agent-monitor-mark" aria-hidden="true" />
      <span>
        {monitor?.fired ? 'Woke the chat: ' : `Watching ${which} - when ${ask?.when === 'each' ? 'each is' : 'all are'} done: `}
        {ask?.note || 'report back'}
      </span>
    </div>
  )
}

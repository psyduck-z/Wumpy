import { useCallback, useEffect, useState } from 'react'
import type { ApprovalMode, Dock, SyncInfo, VoiceprintState, WumpySettings } from '@shared/types'
import { DEFAULT_ENGINE, SEARCH_ENGINES, isSearchEngine } from '@shared/links'
import { APP_WINDOW } from '../appwindow'
import { DOCK_CYCLE } from './Header'

/**
 * Settings, to click: "in settings you can see the devices you're paired
 * with, etc." The same things the commands change - each row's title says
 * which, for anybody who would rather type it - and sync first, because it
 * is the one that has things in it (devices) rather than a switch.
 */

/** Markdown out of a one-line note from main: these are shown as plain text here. */
const plain = (s: string): string => s.replace(/\*\*|`/g, '')

function ago(at?: number): string {
  if (!at) return 'not synced yet'
  const min = Math.round((Date.now() - at) / 60_000)
  if (min < 1) return 'synced just now'
  if (min < 60) return `synced ${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `synced ${h} h ago` : `synced ${Math.round(h / 24)} days ago`
}

function Toggle({ on, onChange, label }: { on: boolean; onChange(next: boolean): void; label: string }): React.JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)}>
      <i aria-hidden="true" />
    </button>
  )
}

function Row({
  what,
  sub,
  cmd,
  children
}: {
  what: string
  sub?: string
  /** The command that does the same, shown on hover. */
  cmd?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-row" title={cmd ? `Also: ${cmd}` : undefined}>
      <div className="set-label">
        <span>{what}</span>
        {sub && <span className="set-sub">{sub}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

const APPROVALS: Array<{ id: ApprovalMode; label: string; sub: string }> = [
  { id: 'manual', label: 'Ask', sub: 'every command waits for you' },
  { id: 'auto', label: 'Auto', sub: 'read-only runs itself, changes ask' },
  { id: 'all', label: 'Accept all', sub: 'everything runs, nothing asks' }
]

export function SettingsTab({
  settings,
  model,
  pool,
  pinned,
  syncTick,
  onPatch,
  onApproval,
  onPin,
  onDock,
  onModel,
  onCommand,
  onCalibrate,
  onSkillsChanged
}: {
  settings: WumpySettings
  model: string
  pool: { keys: number; ready: number } | null
  pinned: boolean
  /** Bumped when main says something changed about sync ("Paired with ..."). */
  syncTick: number
  onPatch(p: Partial<WumpySettings>): Promise<unknown>
  onApproval(mode: ApprovalMode): void
  onPin(next: boolean): void
  onDock(d: Dock): void
  onModel(): void
  /** Runs a command on the Chat tab, for the few that are a conversation (keys). */
  onCommand(cmd: string): void
  onCalibrate(): void
  onSkillsChanged(): void
}): React.JSX.Element {
  const [sync, setSync] = useState<SyncInfo | null>(null)
  const [print, setPrint] = useState<VoiceprintState | null>(null)
  const [code, setCode] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.wumpy.skills.syncInfo().then(setSync).catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    void window.wumpy.voice.print().then(setPrint).catch(() => undefined)
    /* "Here" and "synced 2 min ago" go stale; so does a code once it is used. */
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [refresh])
  useEffect(() => {
    if (syncTick) {
      setShown(null)
      refresh()
    }
  }, [syncTick, refresh])

  const run = async (what: string, req: Parameters<typeof window.wumpy.skills.sync>[0]): Promise<string | null> => {
    setWorking(what)
    try {
      const r = await window.wumpy.skills.sync(req)
      setSaid({ text: plain(r.message), bad: !r.ok })
      if (r.changed) onSkillsChanged()
      return r.ok ? r.message : null
    } catch {
      setSaid({ text: 'That did not work.', bad: true })
      return null
    } finally {
      setWorking(null)
      refresh()
    }
  }

  const showCode = async (): Promise<void> => {
    setSaid(null)
    const m = await run('show', { action: 'pair' })
    const digits = m ? /(\d{6})/.exec(m)?.[1] : undefined
    if (digits) {
      setShown(`${digits.slice(0, 3)} ${digits.slice(3)}`)
      /* The code itself is the message; the line under it would repeat it. */
      setSaid(/Firewall/.test(m ?? '') ? { text: 'Firewall left closed: the other device may not find this one.', bad: true } : null)
    }
  }

  const engine = isSearchEngine(settings.searchEngine) ? settings.searchEngine : DEFAULT_ENGINE
  const toggle = (key: keyof WumpySettings) => (next: boolean) => void onPatch({ [key]: next } as Partial<WumpySettings>)

  return (
    <div className="tab-page" role="tabpanel">
      <section className="set-section">
        <h2>Sync skills</h2>
        <Row what="Over Wi-Fi" sub="with devices you have paired, no account" cmd="/sync pair">
          <Toggle on={sync?.wifi ?? settings.lanSync} label="Sync over Wi-Fi" onChange={toggle('lanSync')} />
        </Row>
        {sync?.peers.length ? (
          <ul className="device-list">
            {sync.peers.map((p) => (
              <li key={p.name}>
                <i className={`device-dot ${p.here ? 'is-here' : ''}`} title={p.here ? 'On this Wi-Fi now' : 'Not heard from lately'} />
                <span className="device-name">{p.name}</span>
                <span className="set-sub">{ago(p.synced)}</span>
                <button type="button" className="btn btn-quiet" disabled={working !== null} onClick={() => void run('unpair', { action: 'unpair', arg: p.name })}>
                  Unpair
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="set-sub set-note">No devices paired yet.</p>
        )}
        {shown ? (
          <div className="pair-code" role="status">
            <span className="set-sub">On the other device, type this in Settings → Pair (lasts 5 min):</span>
            <strong>{shown}</strong>
            <button type="button" className="btn btn-quiet" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        ) : (
          <div className="pair-row">
            <button type="button" className="btn" disabled={working !== null} onClick={() => void showCode()}>
              {working === 'show' ? 'Opening…' : 'Show a code'}
            </button>
            <span className="set-sub">or</span>
            <input
              className="field"
              inputMode="numeric"
              placeholder="code from the other device"
              value={code}
              maxLength={7}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.replace(/\s/g, '').length === 6) void run('pair', { action: 'pair', arg: code }).then(() => setCode(''))
              }}
            />
            <button
              type="button"
              className="btn btn-accent"
              disabled={working !== null || code.replace(/\s/g, '').length !== 6}
              onClick={() => void run('pair', { action: 'pair', arg: code }).then(() => setCode(''))}
            >
              {working === 'pair' ? 'Looking…' : 'Pair'}
            </button>
          </div>
        )}
        <Row
          what="Through GitHub"
          sub={
            sync?.github.on
              ? sync.github.token
                ? `as ${sync.github.account ?? 'your account'} — an unlisted gist`
                : 'needs a token with the gist scope'
              : 'for devices that are never on the same Wi-Fi'
          }
          cmd="/sync on"
        >
          <Toggle on={sync?.github.on ?? settings.skillSync} label="Sync through GitHub" onChange={(next) => void onPatch({ skillSync: next }).then(refresh)} />
        </Row>
        {sync?.github.on && !sync.github.token && (
          <div className="pair-row">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => void window.wumpy.links.open('https://github.com/settings/tokens/new?scopes=gist&description=Wumpy%20skills')}
            >
              Make a token
            </button>
            <input className="field" type="password" placeholder="paste it here" value={token} onChange={(e) => setToken(e.target.value.trim())} />
            <button
              type="button"
              className="btn btn-accent"
              disabled={!token || working !== null}
              onClick={() => void run('key', { action: 'key', token }).then(() => setToken(''))}
            >
              Save
            </button>
          </div>
        )}
        <div className="pair-row">
          <button
            type="button"
            className="btn"
            disabled={working !== null || !((sync?.wifi && sync.peers.length) || (sync?.github.on && sync.github.token))}
            onClick={() => void run('now', { action: 'now' })}
          >
            {working === 'now' ? 'Syncing…' : 'Sync now'}
          </button>
          {said && <span className={`set-said ${said.bad ? 'is-bad' : ''}`}>{said.text}</span>}
        </div>
      </section>

      <section className="set-section">
        <h2>Answers</h2>
        <Row what="Model" sub={model} cmd="/model">
          <button type="button" className="btn" onClick={onModel}>
            Change
          </button>
        </Row>
        <Row what="Keys" sub={pool ? `${pool.ready} of ${pool.keys} ready for this model` : 'none for this model'} cmd="/key">
          <button type="button" className="btn" onClick={() => onCommand('/key')}>
            Keys
          </button>
        </Row>
        <Row what="Think first" sub="better answers, slower first word" cmd="/think">
          <Toggle on={settings.thinking} label="Think first" onChange={toggle('thinking')} />
        </Row>
        <Row what="Show reasoning" cmd="/reasoning">
          <Toggle on={settings.showReasoning} label="Show reasoning" onChange={toggle('showReasoning')} />
        </Row>
        <Row what="Self-review" sub={`up to ${settings.reflectRounds} reviews per task`} cmd="/reflect">
          <Toggle on={settings.reflect} label="Self-review" onChange={toggle('reflect')} />
        </Row>
        <Row what="Short instructions" sub="about 2,500 fewer tokens a turn" cmd="/lean">
          <Toggle on={settings.leanPrompt} label="Short instructions" onChange={toggle('leanPrompt')} />
        </Row>
        <Row what="Re-rank models every 30 min" cmd="/rank">
          <Toggle on={settings.autoRank} label="Re-rank models" onChange={(next) => void window.wumpy.rank.set({ on: next }).then(() => onPatch({}))} />
        </Row>
      </section>

      <section className="set-section">
        <h2>Commands and the web</h2>
        <Row what="Commands" sub={APPROVALS.find((a) => a.id === settings.approvalMode)?.sub} cmd="Shift+Tab">
          <div className="seg" role="radiogroup" aria-label="Commands">
            {APPROVALS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={settings.approvalMode === a.id} className={settings.approvalMode === a.id ? 'is-on' : ''} onClick={() => onApproval(a.id)}>
                {a.label}
              </button>
            ))}
          </div>
        </Row>
        <Row what="Searches open in" cmd="/engine">
          <select className="field" value={engine} onChange={(e) => void onPatch({ searchEngine: e.target.value })}>
            {Object.entries(SEARCH_ENGINES).map(([id, e]) => (
              <option key={id} value={id}>
                {e.label}
              </option>
            ))}
          </select>
        </Row>
      </section>

      <section className="set-section">
        <h2>Voice</h2>
        <Row what="Voice" sub="hold the spacebar and talk" cmd="/voice">
          <Toggle on={settings.voiceEnabled} label="Voice" onChange={toggle('voiceEnabled')} />
        </Row>
        <Row
          what="Only my voice"
          sub={
            !print
              ? undefined
              : !print.on
                ? 'off: anyone can talk to it'
                : print.known
                  ? print.calibrated
                    ? 'on, calibrated'
                    : 'on'
                  : `learning: ${print.clips} of ${print.needed}`
          }
          cmd="/voice me"
        >
          <button type="button" className="btn btn-quiet" onClick={onCalibrate}>
            Calibrate
          </button>
          <Toggle on={print?.on ?? false} label="Only my voice" onChange={(next) => void window.wumpy.voice.setPrint({ on: next }).then(setPrint)} />
        </Row>
        <Row what="Tidy up dictation" cmd="/polish">
          <Toggle on={settings.voicePolish} label="Tidy up dictation" onChange={toggle('voicePolish')} />
        </Row>
        <Row what="Stop at a pause" cmd="/autostop">
          <Toggle on={settings.voiceAutoStop} label="Stop at a pause" onChange={toggle('voiceAutoStop')} />
        </Row>
        <Row what="Pause music while talking" cmd="/music">
          <Toggle on={settings.pauseMusic ?? true} label="Pause music while talking" onChange={toggle('pauseMusic')} />
        </Row>
      </section>

      <section className="set-section">
        <h2>Panel</h2>
        {!APP_WINDOW && (
          <>
            <Row what="Stay on top" sub="otherwise it hides when you click away" cmd="/pin">
              <Toggle on={pinned} label="Stay on top" onChange={onPin} />
            </Row>
            <Row what="Position" cmd="/dock">
              <select className="field" value={settings.dock} onChange={(e) => onDock(e.target.value as Dock)}>
                {DOCK_CYCLE.map((d) => (
                  <option key={d} value={d}>
                    {d.replace('-', ' ')}
                  </option>
                ))}
              </select>
            </Row>
          </>
        )}
        <Row what="Start at login" sub="in the background" cmd="/startup">
          <Toggle on={settings.launchAtLogin} label="Start at login" onChange={toggle('launchAtLogin')} />
        </Row>
      </section>
    </div>
  )
}

import type { AssistantStatus, Dock, UpdateState } from '@shared/types'
import { APP_WINDOW } from '../appwindow'
import logo from '../assets/logo.png'

/** The order the dock button and Ctrl+D both step through. */
export const DOCK_CYCLE: Dock[] = [
  'right',
  'bottom-right',
  'bottom-left',
  'left',
  'top-left',
  'top-right'
]

/** Small glyph showing where on the screen the panel currently sits. */
function DockGlyph({ dock }: { dock: Dock }): React.JSX.Element {
  const tall = dock === 'left' || dock === 'right'
  const right = dock === 'right' || dock === 'top-right' || dock === 'bottom-right'
  const bottom = dock === 'bottom-left' || dock === 'bottom-right'

  const w = tall ? 5 : 7
  const h = tall ? 14 : 6
  const x = right ? 16 - w - 1 : 1
  const y = tall ? 1 : bottom ? 16 - h - 1 : 1

  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="15"
        height="15"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        opacity="0.4"
      />
      <rect x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" />
    </svg>
  )
}

export function Header({
  status,
  dock,
  onCycleDock,
  pinned,
  onTogglePin,
  onNewChat,
  onShowChats,
  onRename,
  onClose,
  hotkeyLabel,
  title,
  update,
  busy,
  onUpdate
}: {
  status: AssistantStatus | null
  dock: Dock
  onCycleDock(next: Dock): void
  pinned: boolean
  onTogglePin(): void
  onNewChat(): void
  onShowChats(): void
  /** Clicking the title offers to rename it. */
  onRename(): void
  onClose(): void
  hotkeyLabel: string
  title: string | null
  /** Wumpy's own update: a pill while it downloads, and once it is ready. */
  update: UpdateState | null
  /** An answer is being written: the restart waits for it. */
  busy: boolean
  /** Restart into the downloaded update, saving the chat first. */
  onUpdate(): void
}): React.JSX.Element {
  const online = status?.ready ?? false
  const nextDock = DOCK_CYCLE[(DOCK_CYCLE.indexOf(dock) + 1) % DOCK_CYCLE.length]

  /* The pill needs the room, and the shortcut hint is the thing worth least
     while it is there: the title is cut to "Downloads cl..." and the hint to
     "Sup..." otherwise, in a 440px panel. */
  const updating =
    update?.stage === 'downloading' || update?.stage === 'ready' || update?.stage === 'available' || update?.stage === 'installing'

  return (
    <header className={`header ${updating ? 'has-update' : ''}`}>
      <div className="brand">
        <span className="brand-mark">
          <img src={logo} alt="" width={18} height={18} />
          {/* The connection light rides the corner of the mark. */}
          <span className={`dot ${online ? 'dot-on' : 'dot-off'}`} />
        </span>
        {/* The obvious thing to try on a title is to click it, and it used to
            do nothing at all. */}
        {title ? (
          <button type="button" className="brand-title" onClick={onRename} title="Rename this chat">
            {title}
          </button>
        ) : (
          <strong>Wumpy</strong>
        )}
        <span className="hint">{online ? hotkeyLabel : (status?.why ?? 'no key yet')}</span>
      </div>

      <div className="header-actions">
        {update?.stage === 'downloading' && (
          <span
            className="update-pill is-getting"
            title={`Downloading Wumpy ${update.next} - it installs once it is ready`}
          >
            updating {update.percent ?? 0}%
          </span>
        )}
        {update?.stage === 'installing' && (
          <span
            className="update-pill is-getting"
            title={`Building and installing ${update.about ?? 'the update'} - Wumpy restarts into it when it is done`}
          >
            updating…
          </span>
        )}
        {update?.stage === 'available' && (
          <button
            type="button"
            className="update-pill is-ready"
            onClick={onUpdate}
            disabled={busy}
            title={
              busy
                ? 'After this answer: builds the update and restarts into it'
                : `There is ${update.about ?? 'an update'}. Build and install it now (/update) - a few minutes, then Wumpy restarts into it and this chat opens again.`
            }
          >
            Update available
          </button>
        )}
        {update?.stage === 'ready' && (
          <button
            type="button"
            className="update-pill is-ready"
            onClick={onUpdate}
            disabled={busy}
            title={
              busy
                ? 'After this answer: restarts into the new version'
                : update.about
                  ? `The update (${update.about}) is built and installed. Restart into it now - this chat opens again. Otherwise Wumpy restarts into it by itself while nobody is using it.`
                  : `Wumpy ${update.next} is downloaded (this is ${update.current}). Restart into it now - this chat opens again. Otherwise it installs itself while nobody is using Wumpy.`
            }
          >
            Update ready
          </button>
        )}
        <button type="button" onClick={onShowChats} title="Saved chats (/chats)">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M2 4.5h12M2 8h12M2 11.5h8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button type="button" onClick={onNewChat} title="New chat (/new)">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M8 3v10M3 8h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {/* The overlay's own controls. An app window on Omarchy is placed by
            Hyprland and never floats, so it has neither (see appwindow.ts). */}
        {!APP_WINDOW && (
          <>
            <button
              type="button"
              onClick={() => onCycleDock(nextDock)}
              title={`Move panel — now ${dock}, next ${nextDock}`}
            >
              <DockGlyph dock={dock} />
            </button>

            <button
              type="button"
              onClick={onTogglePin}
              className={pinned ? 'is-on' : ''}
              title={
                pinned
                  ? 'Pinned — stays on top. Click to let it hide when you click away.'
                  : 'Auto-hide — closes when it loses focus. Click to keep it on top.'
              }
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M6 2h4l-.6 4.2 2.1 2.1H4.5l2.1-2.1z M8 8.3V14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {/* Struck through when unpinned, so the state is visible at a glance. */}
                {!pinned && (
                  <path
                    d="M3 13L13 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          title={APP_WINDOW ? 'Hide to the tray' : 'Close (Esc)'}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </header>
  )
}

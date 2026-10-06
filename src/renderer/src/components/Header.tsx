import type { Dock, Mode, OllamaStatus } from '@shared/types'

const DOCK_CYCLE: Dock[] = [
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
      <rect x="0.5" y="0.5" width="15" height="15" rx="2.5" fill="none" stroke="currentColor" opacity="0.4" />
      <rect x={x} y={y} width={w} height={h} rx="1.5" fill="currentColor" />
    </svg>
  )
}

export function Header({
  mode,
  onToggleMode,
  status,
  dock,
  onCycleDock,
  pinned,
  onTogglePin,
  onNewChat,
  onShowChats,
  onClose,
  hotkeyLabel,
  title
}: {
  mode: Mode
  onToggleMode(): void
  status: OllamaStatus | null
  dock: Dock
  onCycleDock(next: Dock): void
  pinned: boolean
  onTogglePin(): void
  onNewChat(): void
  onShowChats(): void
  onClose(): void
  hotkeyLabel: string
  title: string | null
}): React.JSX.Element {
  const online = status?.reachable ?? false
  const nextDock = DOCK_CYCLE[(DOCK_CYCLE.indexOf(dock) + 1) % DOCK_CYCLE.length]

  return (
    <header className="header">
      <div className="brand">
        <span className={`dot ${online ? 'dot-on' : 'dot-off'}`} />
        <strong>{title ?? 'Wumpy'}</strong>
        <span className="hint">{online ? hotkeyLabel : (status?.error ?? 'connecting…')}</span>
      </div>

      <div className="header-actions">
        <button
          type="button"
          className={`mode-toggle ${mode === 'dev' ? 'is-dev' : ''}`}
          onClick={onToggleMode}
          title={
            mode === 'quick'
              ? 'Switch to Developer mode — Thinker & Deep Thinker (Ctrl+D)'
              : 'Back to Quick mode — Flash & Fast (Ctrl+D)'
          }
        >
          {mode === 'quick' ? 'Quick' : 'Dev'}
        </button>

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
          title={pinned ? 'Unpin — closes when it loses focus' : 'Pin — stay open while you work'}
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
          </svg>
        </button>

        <button type="button" onClick={onClose} title="Close (Esc)">
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

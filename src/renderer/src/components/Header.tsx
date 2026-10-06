import type { OllamaModel, OllamaStatus } from '@shared/types'

export function Header({
  models,
  model,
  onModelChange,
  status,
  pinned,
  onTogglePin,
  onClear,
  onClose,
  hotkeyLabel
}: {
  models: OllamaModel[]
  model: string
  onModelChange(name: string): void
  status: OllamaStatus | null
  pinned: boolean
  onTogglePin(): void
  onClear(): void
  onClose(): void
  hotkeyLabel: string
}): React.JSX.Element {
  const online = status?.reachable ?? false

  return (
    <header className="header">
      <div className="brand">
        <span className={`dot ${online ? 'dot-on' : 'dot-off'}`} />
        <strong>Wumpy</strong>
        <span className="hint">{online ? hotkeyLabel : status?.error ?? 'connecting…'}</span>
      </div>

      <div className="header-actions">
        <select
          className="model"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          title="Model"
        >
          {models.length === 0 && <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>

        <button type="button" onClick={onClear} title="New chat">
          New
        </button>
        <button
          type="button"
          onClick={onTogglePin}
          className={pinned ? 'active' : ''}
          title={pinned ? 'Unpin (closes when it loses focus)' : 'Pin (stay open while you work)'}
        >
          {pinned ? 'Pinned' : 'Pin'}
        </button>
        <button type="button" onClick={onClose} title="Close (Esc)">
          &#10005;
        </button>
      </div>
    </header>
  )
}

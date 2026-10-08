import { useRef } from 'react'
import type { Mode, TierId, TierStatus } from '@shared/types'
import { arrowNavigate } from '../keyboard'
import { TIERS, tiersForMode, SPEED_LABEL } from '@shared/tiers'

/**
 * The tier selector. Only the current mode's two tiers are offered — switching
 * to the others is a deliberate mode change, which is also what repaints the
 * whole panel from the light Quick theme to the dark Developer one.
 */
export function TierBar({
  mode,
  tier,
  statuses,
  onPick
}: {
  mode: Mode
  tier: TierId
  statuses: TierStatus[]
  onPick(id: TierId): void
}): React.JSX.Element {
  const byId = new Map(statuses.map((s) => [s.id, s]))
  const barRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={barRef}
      className="tierbar"
      role="radiogroup"
      aria-label="Thinking tier"
      // A radiogroup is expected to move with the arrows, and this one has
      // the mode's two tiers in it. Ctrl+1..4 still works and is still
      // printed on each button.
      onKeyDown={(e) => {
        if (arrowNavigate(e, barRef.current)) e.preventDefault()
      }}
    >
      {tiersForMode(mode).map((id, i) => {
        const t = TIERS[id]
        const status = byId.get(id)
        const installed = status?.installed ?? false

        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={tier === id}
            className={`tier ${tier === id ? 'is-active' : ''} ${installed ? '' : 'is-missing'}`}
            onClick={() => installed && onPick(id)}
            title={
              installed
                ? `${t.blurb}  (${status?.resolvedModel}, ${SPEED_LABEL[t.speed]})`
                : `No model installed. Try: ollama pull ${t.model}`
            }
          >
            <span className="tier-label">
              {t.label}
              <kbd className="tier-key">{`Ctrl+${mode === 'quick' ? i + 1 : i + 3}`}</kbd>
            </span>
            <span className="tier-meta">
              {!installed ? (
                'not installed'
              ) : (
                <>
                  {SPEED_LABEL[t.speed]}
                  {status?.warm ? <span className="warm-dot" title="Model is loaded" /> : null}
                </>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

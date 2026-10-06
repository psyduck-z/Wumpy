import { useEffect, useState } from 'react'
import type { ChatSummary } from '@shared/types'
import { TIERS } from '@shared/tiers'

function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Saved-chat browser, shown in place of the transcript. */
export function ChatList({
  chats,
  activeId,
  onOpen,
  onDelete,
  onClose
}: {
  chats: ChatSummary[]
  activeId: string | null
  onOpen(id: string): void
  onDelete(id: string): void
  onClose(): void
}): React.JSX.Element {
  // Two-step delete: a row must be armed before it will actually go.
  const [armed, setArmed] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 3000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <div className="chatlist">
      <div className="chatlist-head">
        <strong>Saved chats</strong>
        <span className="chatlist-count">{chats.length}</span>
        <button type="button" className="link" onClick={onClose}>
          Back
        </button>
      </div>

      {chats.length === 0 ? (
        <p className="chatlist-empty">
          Nothing saved yet. Use <code>/save</code> to keep the current chat.
        </p>
      ) : (
        <div className="chatlist-rows">
          {chats.map((c) => (
            <div key={c.id} className={`chatrow ${c.id === activeId ? 'is-active' : ''}`}>
              <button type="button" className="chatrow-main" onClick={() => onOpen(c.id)}>
                <span className="chatrow-title">{c.title}</span>
                <span className="chatrow-meta">
                  {TIERS[c.tier]?.label ?? c.tier} &middot; {c.messageCount} msg &middot;{' '}
                  {when(c.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className={`chatrow-del ${armed === c.id ? 'is-armed' : ''}`}
                title={armed === c.id ? 'Click again to delete' : 'Delete'}
                onClick={() => {
                  if (armed === c.id) {
                    onDelete(c.id)
                    setArmed(null)
                  } else {
                    setArmed(c.id)
                  }
                }}
              >
                {armed === c.id ? 'Sure?' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

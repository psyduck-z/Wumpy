import { useEffect, useRef, useState } from 'react'
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

/**
 * Saved-chat picker, shown in place of the transcript.
 *
 * Driven by the keyboard the way a resume prompt should be: type to filter,
 * arrows to move, Enter to open, Delete to remove.
 */
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
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  // Two-step delete: a row must be armed before it will actually go.
  const [armed, setArmed] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)

  const visible = filter
    ? chats.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()))
    : chats

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setCursor(0), [filter])

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 3000)
    return () => clearTimeout(t)
  }, [armed])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const el = rowsRef.current?.children[cursor] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((i) => Math.min(visible.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = visible[cursor]
      if (hit) onOpen(hit.id)
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.ctrlKey)) {
      const hit = visible[cursor]
      if (!hit) return
      e.preventDefault()
      if (armed === hit.id) {
        onDelete(hit.id)
        setArmed(null)
      } else {
        setArmed(hit.id)
      }
    }
  }

  return (
    <div className="chatlist" onKeyDown={onKeyDown}>
      <div className="chatlist-head">
        <input
          ref={inputRef}
          className="chatlist-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Resume a chat… (${chats.length})`}
          spellCheck={false}
        />
        <button type="button" className="link" onClick={onClose}>
          Back
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="chatlist-empty">
          {chats.length === 0 ? (
            <>Nothing saved yet. Chats save themselves as you go.</>
          ) : (
            <>No chat matches &ldquo;{filter}&rdquo;.</>
          )}
        </p>
      ) : (
        <div className="chatlist-rows" ref={rowsRef}>
          {visible.map((c, i) => (
            <div
              key={c.id}
              className={`chatrow ${c.id === activeId ? 'is-active' : ''} ${
                i === cursor ? 'is-cursor' : ''
              }`}
            >
              <button
                type="button"
                className="chatrow-main"
                onMouseEnter={() => setCursor(i)}
                onClick={() => onOpen(c.id)}
              >
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

      <div className="chatlist-foot">
        <kbd>&uarr;</kbd>
        <kbd>&darr;</kbd> move &middot; <kbd>Enter</kbd> open &middot; <kbd>Del</kbd> delete
        &middot; <kbd>Esc</kbd> back
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

export interface PickerItem {
  id: string
  title: string
  /** Secondary line under the title. */
  meta?: string
  /**
   * A short badge beside the title, for a fact worth seeing before reading.
   *
   * Added for the model list, where the thing being chosen between is how
   * good each one is and that was buried mid-sentence in `meta`. `tone`
   * colours it by band so the order is visible without reading any of them.
   */
  tag?: { text: string; tone: 'top' | 'good' | 'fair' | 'weak'; title?: string }
  /** Right-aligned hint, such as a keyboard shortcut. */
  hint?: string
  /** Greyed out and not selectable. */
  disabled?: boolean
  /** Marked as the current choice. */
  active?: boolean
}

export interface PickerProps {
  heading: string
  placeholder: string
  items: PickerItem[]
  onPick(id: string): void
  onClose(): void
  /** When given, rows can be removed and Enter confirms rather than picks. */
  onRemove?: (id: string) => void
  /** Enter removes instead of picking. Used by /delete. */
  removeMode?: boolean
  emptyText?: string
}

/**
 * One list UI for every "choose a thing" command — chats, tiers, models,
 * positions.
 *
 * The point is that nothing has to be remembered: the options are on screen,
 * arrow keys move, typing filters, Enter commits. Commands that take a name
 * still accept one, but never require it.
 */
export function Picker({
  heading,
  placeholder,
  items,
  onPick,
  onClose,
  onRemove,
  removeMode = false,
  emptyText
}: PickerProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  /** Row armed for removal; a second confirm actually removes it. */
  const [armed, setArmed] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)

  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) || (i.meta ?? '').toLowerCase().includes(needle)
      )
    : items

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

  /** Skips disabled rows so the cursor never rests on something unusable. */
  const move = (delta: number): void => {
    if (visible.length === 0) return
    let next = cursor
    for (let step = 0; step < visible.length; step++) {
      next = (next + delta + visible.length) % visible.length
      if (!visible[next].disabled) break
    }
    setCursor(next)
  }

  const commit = (item: PickerItem): void => {
    if (item.disabled) return
    if (!removeMode || !onRemove) {
      onPick(item.id)
      return
    }
    if (armed === item.id) {
      onRemove(item.id)
      setArmed(null)
    } else {
      setArmed(item.id)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = visible[cursor]
      if (hit) commit(hit)
    } else if (onRemove && (e.key === 'Delete' || (e.key === 'Backspace' && e.ctrlKey))) {
      const hit = visible[cursor]
      if (!hit) return
      e.preventDefault()
      if (armed === hit.id) {
        onRemove(hit.id)
        setArmed(null)
      } else {
        setArmed(hit.id)
      }
    }
  }

  return (
    <div className="picker" onKeyDown={onKeyDown}>
      <div className="picker-head">
        <span className="picker-heading">{heading}</span>
        <input
          ref={inputRef}
          className="picker-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <button type="button" className="link" onClick={onClose}>
          Back
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="picker-empty">
          {items.length === 0 ? (emptyText ?? 'Nothing here yet.') : `No match for “${filter}”.`}
        </p>
      ) : (
        <div className="picker-rows" ref={rowsRef}>
          {visible.map((item, i) => (
            <div
              key={item.id}
              className={[
                'picker-row',
                item.active ? 'is-active' : '',
                i === cursor ? 'is-cursor' : '',
                item.disabled ? 'is-disabled' : '',
                removeMode ? 'is-removing' : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className="picker-main"
                disabled={item.disabled}
                onMouseEnter={() => !item.disabled && setCursor(i)}
                onClick={() => commit(item)}
              >
                <span className="picker-title">
                  {item.title}
                  {item.tag && (
                    <span className={`picker-tag is-${item.tag.tone}`} title={item.tag.title}>
                      {item.tag.text}
                    </span>
                  )}
                  {item.active && <span className="picker-dot" title="Current" />}
                </span>
                {item.meta && <span className="picker-meta">{item.meta}</span>}
              </button>

              {item.hint && !removeMode && <kbd className="picker-hint">{item.hint}</kbd>}

              {onRemove && (
                <button
                  type="button"
                  className={`picker-del ${armed === item.id ? 'is-armed' : ''}`}
                  title={armed === item.id ? 'Click again to delete' : 'Delete'}
                  onClick={() => {
                    if (armed === item.id) {
                      onRemove(item.id)
                      setArmed(null)
                    } else {
                      setArmed(item.id)
                    }
                  }}
                >
                  {armed === item.id ? 'Sure?' : '✕'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="picker-foot">
        <kbd>&uarr;</kbd>
        <kbd>&darr;</kbd> move &middot; <kbd>Enter</kbd> {removeMode ? 'delete (twice)' : 'choose'}
        {onRemove && !removeMode && (
          <>
            {' '}
            &middot; <kbd>Del</kbd> delete
          </>
        )}{' '}
        &middot; <kbd>Esc</kbd> back
      </div>
    </div>
  )
}

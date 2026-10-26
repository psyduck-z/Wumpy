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
  /**
   * A second badge, for a capability rather than a score.
   *
   * Kept apart from `tag` instead of appended to its text, because they
   * answer different questions: one is how well it did on the ladder and
   * moves every time it is measured, the other is whether it can see at
   * all and does not move. Crowding both into "#2 · 36/41 · vision" would
   * read as one claim.
   */
  badge?: { text: string; title?: string }
  /** Right-aligned hint, such as a keyboard shortcut. */
  hint?: string
  /** Greyed out and not selectable. */
  disabled?: boolean
  /** Marked as the current choice. */
  active?: boolean
}

/**
 * A few ways to read the same list, above it.
 *
 * Added for the model picker, where the thing being chosen between has two
 * measurements that disagree - the cleverest model here is the slowest by
 * two orders of magnitude - and one list cannot be sorted on both. Tabs
 * rather than a sort menu because there are three and they are the whole
 * question: "smartest", "fastest", and the compromise that used to be the
 * only order without saying so.
 *
 * `note` is under the tabs rather than in a tooltip because each one makes
 * a claim about where its numbers come from, and that claim is the reason
 * somebody picks a tab.
 */
export interface PickerTabs {
  items: Array<{ id: string; label: string; tag?: string; title?: string }>
  active: string
  /** What the showing tab means, in one sentence. Markdown-free. */
  note?: string
  onPick(id: string): void
}

export interface PickerProps {
  heading: string
  placeholder: string
  items: PickerItem[]
  onPick(id: string): void
  onClose(): void
  /** Ways to order or group the list. Absent for every list with one order. */
  tabs?: PickerTabs
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
  tabs,
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

  /**
   * Whether the highlight should drag the list to it.
   *
   * It must when a key moved it - that is the whole point of arrowing
   * through a list taller than the panel - and it must NOT when the mouse
   * did, which is the bug: "when I scroll down, my cursor goes back up, but
   * then everything shifts... and my cursor goes back to the start".
   *
   * The loop was: the wheel scrolls, a row slides under the stationary
   * pointer, mouseenter moves the highlight to it, and the effect below
   * scrolls that row into view. A row at the top edge is half cut off while
   * the wheel is moving, so "into view" means scrolling back up by the part
   * that was cut - undoing the scroll, over and over, and cancelling the
   * wheel's own animation each time it did.
   *
   * A mouse-moved highlight never needs scrolling to anyway: the row is
   * under the pointer, which is as visible as a thing gets.
   */
  const follow = useRef(false)

  /** Where the pointer was, to tell a real move from a row sliding under it. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => inputRef.current?.focus(), [])
  /* Back to the top, and scrolled there: the rows under the cursor are not
     the rows that were there a keystroke ago. */
  useEffect(() => {
    follow.current = true
    setCursor(0)
  }, [filter])
  /* Switching tabs re-sorts the rows under the cursor, so the highlight
     would stay on row four and mean something else. Back to the top, which
     is where the answer to "which is best on this one" now is. */
  useEffect(() => {
    follow.current = true
    setCursor(0)
  }, [tabs?.active])

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 3000)
    return () => clearTimeout(t)
  }, [armed])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!follow.current) return
    follow.current = false
    const el = rowsRef.current?.children[cursor] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  /**
   * The highlight following the pointer, when the pointer is what moved.
   *
   * mousemove rather than mouseenter, because Chromium sends a mousemove at
   * the same coordinates after content scrolls under a still pointer - and
   * an enter event cannot be told apart from a real one at all. Same
   * coordinates as last time means the mouse did not move, whatever else
   * did.
   */
  const pointAt = (i: number, x: number, y: number): void => {
    if (pointer.current?.x === x && pointer.current?.y === y) return
    pointer.current = { x, y }
    follow.current = false
    setCursor(i)
  }

  /** Skips disabled rows so the cursor never rests on something unusable. */
  const move = (delta: number): void => {
    if (visible.length === 0) return
    let next = cursor
    for (let step = 0; step < visible.length; step++) {
      next = (next + delta + visible.length) % visible.length
      if (!visible[next].disabled) break
    }
    follow.current = true
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

  /**
   * Straight to one end of the list, past anything unpickable.
   *
   * The command list is sixty rows now that the keys are in it, and the only
   * way down was to hold an arrow key or to know what to type. The ends are
   * where the two obvious things are: the first match, and whatever was
   * added last.
   */
  const jump = (to: 'first' | 'last'): void => {
    if (visible.length === 0) return
    const order = visible.map((_, i) => (to === 'first' ? i : visible.length - 1 - i))
    const hit = order.find((i) => !visible[i].disabled)
    if (hit === undefined) return
    follow.current = true
    setCursor(hit)
  }

  /**
   * How far a page moves.
   *
   * Eight rows rather than the height of the list measured in pixels: the
   * rows are a fixed size, the list shows about ten of them, and a number
   * that depends on nothing cannot be wrong after a resize.
   */
  const PAGE = 8

  /** The next tab round, or the previous one. */
  const stepTab = (delta: 1 | -1): void => {
    if (!tabs || tabs.items.length < 2) return
    const at = tabs.items.findIndex((t) => t.id === tabs.active)
    const next = tabs.items[(Math.max(0, at) + delta + tabs.items.length) % tabs.items.length]
    tabs.onPick(next.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    /*
     * Tab moves between tabs, which is what the key is for.
     *
     * stopPropagation, not just preventDefault: Shift+Tab cycles approval
     * mode from a listener on the window, and cycling the permission model
     * because somebody was reading the model list backwards would be a
     * surprise of the worst kind. React's handler runs before the event
     * reaches the window, so stopping it here is enough.
     */
    if (e.key === 'Tab' && tabs && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      stepTab(e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      /*
       * A page at a time through a long list.
       *
       * Taken from the window handler, which would otherwise try to scroll a
       * transcript that is not on screen while a picker is open. Neither key
       * does anything useful in a one-line filter box, so nothing is being
       * stolen from the typing.
       */
      e.preventDefault()
      e.stopPropagation()
      move(e.key === 'PageUp' ? -PAGE : PAGE)
    } else if (e.ctrlKey && (e.key === 'Home' || e.key === 'End')) {
      /*
       * Ctrl, because plain Home and End belong to the filter box - they are
       * how you get to the front of what you typed. Ctrl+Home and Ctrl+End
       * already mean "the ends of the thing you are looking at" everywhere
       * else in the panel, and here the thing you are looking at is a list.
       */
      e.preventDefault()
      e.stopPropagation()
      jump(e.key === 'Home' ? 'first' : 'last')
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

      {tabs && tabs.items.length > 1 && (
        <div className="picker-tabs">
          <div className="picker-tabrow" role="tablist">
            {tabs.items.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tabs.active}
                title={t.title}
                className={`picker-tab ${t.id === tabs.active ? 'is-on' : ''}`}
                onClick={() => tabs.onPick(t.id)}
              >
                {t.label}
                {t.tag && <span className="picker-tabtag">{t.tag}</span>}
              </button>
            ))}
          </div>
          {tabs.note && <p className="picker-note">{tabs.note}</p>}
        </div>
      )}

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
                onMouseMove={(e) => !item.disabled && pointAt(i, e.clientX, e.clientY)}
                onClick={() => commit(item)}
              >
                <span className="picker-title">
                  {item.title}
                  {item.tag && (
                    <span className={`picker-tag is-${item.tag.tone}`} title={item.tag.title}>
                      {item.tag.text}
                    </span>
                  )}
                  {item.badge && (
                    <span className="picker-badge" title={item.badge.title}>
                      {item.badge.text}
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
        {tabs && tabs.items.length > 1 && (
          <>
            {' '}
            &middot; <kbd>Tab</kbd> order
          </>
        )}
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

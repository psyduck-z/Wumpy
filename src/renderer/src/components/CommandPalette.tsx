import { useEffect, useRef } from 'react'
import type { CommandSpec } from '../commands'

/**
 * Autocomplete that appears above the composer as soon as a line starts with
 * `/`. Arrow keys and Tab are handled by the composer, which owns the
 * selection index, so typing never loses focus.
 */
export function CommandPalette({
  items,
  selected,
  onPick
}: {
  items: CommandSpec[]
  selected: number
  onPick(spec: CommandSpec): void
}): React.JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the user arrows through a long list.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (items.length === 0) return null

  return (
    <div className="palette" ref={listRef}>
      {items.map((spec, i) => (
        <button
          key={spec.name}
          type="button"
          className={`palette-row ${i === selected ? 'is-selected' : ''}`}
          // Mouse down would blur the textarea before the click registers.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(spec)
          }}
        >
          <span className="palette-name">
            /{spec.name}
            {spec.arg && <span className="palette-arg"> &lt;{spec.arg}&gt;</span>}
          </span>
          <span className="palette-hint">{spec.hint}</span>
        </button>
      ))}
    </div>
  )
}

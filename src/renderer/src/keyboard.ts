/**
 * Moving around with the arrow keys, everywhere it should be possible.
 *
 * Wumpy is a window that opens on a keystroke, and reaching for the mouse to
 * finish what you started with Win+C breaks the whole point of it. The pieces
 * were half there: the picker had arrows, the composer had history, and every
 * card was built from real buttons so Tab and Enter worked - but reaching a
 * card meant tabbing past everything above it, nothing showed where focus
 * was, and the arrow keys did nothing.
 *
 * The parts that can be pure are pure, so they can be checked without a DOM.
 */

/** Something the user can land on and act with. */
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * The focusable things inside a container, in the order they appear.
 *
 * Hidden ones are left out by measuring rather than by reading styles: a
 * button inside a collapsed section is still in the document and still
 * matches the selector, and tabbing to something invisible is worse than not
 * being able to tab at all.
 */
export function focusablesIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * Where an arrow key should land, given where focus is now.
 *
 * Wraps at both ends, because a row of two or three buttons is a loop in the
 * user's head and stopping dead at the edge just feels broken. Home and End
 * go to the ends. Returns the index to focus, or -1 for "not a key we handle",
 * which the caller uses to decide whether to preventDefault.
 */
export function nextIndex(key: string, current: number, count: number): number {
  if (count <= 0) return -1
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return -1
  }
}

/**
 * Whether a keystroke in a text box was meant for the text box.
 *
 * Arrow keys inside a composer move the caret, and stealing them for
 * navigation would make typing unusable. The one exception the composer
 * already relies on is a caret that cannot move any further, which is how
 * Up reaches the input history - so that decision stays with the composer and
 * this only answers the general question.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  /**
   * Duck-typed rather than `instanceof HTMLElement`.
   *
   * Two reasons, and the second is the one that bites. It makes this
   * checkable without a DOM, which is why the rest of this file is pure. And
   * `instanceof` is per-realm: an element from another window or frame is a
   * perfectly good HTMLElement that fails the test, and the failure mode
   * there is silently stealing a keystroke from something the user is typing
   * in.
   */
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true
}

/**
 * Handles an arrow press inside a group of controls.
 *
 * Returns true when it moved focus, so the caller can preventDefault only in
 * that case and leave every other key alone.
 */
export function arrowNavigate(
  event: { key: string; target: EventTarget | null },
  container: HTMLElement | null
): boolean {
  if (isTypingTarget(event.target)) return false
  const items = focusablesIn(container)
  if (items.length < 2) return false

  const current = items.indexOf(document.activeElement as HTMLElement)
  const next = nextIndex(event.key, current, items.length)
  if (next < 0) return false

  items[next]?.focus()
  return true
}

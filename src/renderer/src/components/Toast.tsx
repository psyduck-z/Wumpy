import { useEffect, useState } from 'react'

/**
 * A line that appears, says one thing, and goes away.
 *
 * For answers that are not part of the conversation. `/resume` with nothing
 * saved used to open an empty picker — a panel with a search box, a list of
 * nothing, and no explanation — and writing "no saved chats" into the
 * transcript instead would be worse: it is not something the model said, and
 * it would still be there tomorrow when the chat is reopened.
 *
 * So it is neither. It shows for a moment and leaves nothing behind.
 */

/** Long enough to read six words, short enough not to be in the way. */
export const TOAST_MS = 2600

/** How long the fade takes, matching the transition in the stylesheet. */
const FADE_MS = 220

export function Toast({
  message,
  onDone
}: {
  /** Null when there is nothing to say; the component then renders nothing. */
  message: { text: string; id: number } | null
  onDone(): void
}): React.JSX.Element | null {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (!message) return
    setLeaving(false)
    // Two timers rather than one: the fade has to start before the element
    // is removed, or it vanishes instead of fading.
    const out = setTimeout(() => setLeaving(true), TOAST_MS - FADE_MS)
    const gone = setTimeout(onDone, TOAST_MS)
    return () => {
      clearTimeout(out)
      clearTimeout(gone)
    }
    // Keyed by id, so the same text said twice shows twice.
  }, [message?.id])

  if (!message) return null
  return (
    <div className={`toast ${leaving ? 'is-leaving' : ''}`} role="status">
      {message.text}
    </div>
  )
}

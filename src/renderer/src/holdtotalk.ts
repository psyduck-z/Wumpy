/**
 * Hold the spacebar to talk.
 *
 * The spacebar is already the most-pressed key there is, so taking it over has
 * to be free when you are typing and obvious when you are not. That is what the
 * delay is for: a space pressed and released is a space, and only a space still
 * held after half a second means something else.
 *
 * Which leaves the spaces that got typed while waiting to find out. Windows
 * auto-repeats a held key about thirty times a second, so by the time the delay
 * is up the box has a run of them in it. They are taken back out - the text
 * returns to exactly what it was when the key went down, caret included - and
 * then recording starts. Releasing sends it.
 *
 * Kept outside React, and kept pure, because this is a state machine over a clock
 * and the ways it goes wrong are all invisible: a timer that survives a release
 * starts recording after the fact; a snapshot taken at the wrong moment eats a
 * word; a repeat treated as a fresh press restarts the delay for ever and the
 * recording never begins. None of those look like anything until they happen.
 */

/**
 * How long the spacebar must be held before it means "listen".
 *
 * Long enough that no ordinary space reaches it - the slowest auto-repeat delay
 * Windows offers is one second, so a held key may not even have repeated yet -
 * and short enough not to feel like waiting.
 */
export const HOLD_MS = 500

/** What the box looked like before the spacebar was pressed. */
export interface Snapshot {
  value: string
  caret: number
}

export type HoldState = 'idle' | 'armed' | 'listening'

export type HoldAction =
  /** Nothing to do; the key event is none of our business. */
  | { kind: 'nothing'; swallow: boolean }
  /** Start the timer. The component calls `tick` when it fires. */
  | { kind: 'arm'; swallow: boolean }
  /** The delay elapsed: put the text back as it was, then start recording. */
  | { kind: 'listen'; restore: Snapshot; swallow: boolean }
  /** Released while listening: stop and transcribe. */
  | { kind: 'send'; swallow: boolean }
  /** Released before the delay, or abandoned: it was just a space. */
  | { kind: 'cancel'; swallow: boolean }

const nothing = (swallow = false): HoldAction => ({ kind: 'nothing', swallow })

export class HoldToTalk {
  private current: HoldState = 'idle'
  private snapshot: Snapshot | null = null
  private pressedAt = 0

  get state(): HoldState {
    return this.current
  }

  /**
   * The spacebar went down, or repeated.
   *
   * The snapshot is taken here, before the browser has inserted anything: a
   * keydown handler runs ahead of the character appearing, so the value read now
   * is the text without the space. Restoring it later removes the space and every
   * repeat after it in one go.
   */
  down(at: number, snapshot: Snapshot): HoldAction {
    if (this.current === 'armed') {
      // A repeat. The delay measures one continuous press, so it must not be
      // restarted - otherwise holding the key for ever never reaches the end of
      // a half-second.
      return nothing()
    }
    if (this.current === 'listening') {
      // Still held while recording. Swallowed, or the repeats would type a line
      // of spaces into the box behind the recording.
      return nothing(true)
    }
    this.current = 'armed'
    this.snapshot = snapshot
    this.pressedAt = at
    // Not swallowed: a space pressed and released has to appear at once, or
    // ordinary typing would stutter every time.
    return { kind: 'arm', swallow: false }
  }

  /** The timer fired. Returns `listen` only if the key is genuinely still held. */
  tick(at: number): HoldAction {
    if (this.current !== 'armed' || !this.snapshot) return nothing()
    if (at - this.pressedAt < HOLD_MS) return nothing()
    this.current = 'listening'
    return { kind: 'listen', restore: this.snapshot, swallow: true }
  }

  /** The spacebar came up. */
  up(): HoldAction {
    if (this.current === 'listening') {
      this.current = 'idle'
      this.snapshot = null
      return { kind: 'send', swallow: true }
    }
    if (this.current === 'armed') {
      this.current = 'idle'
      this.snapshot = null
      // It was a space. It is already in the box, which is where it belongs.
      return { kind: 'cancel', swallow: false }
    }
    return nothing()
  }

  /**
   * Give up: focus left the box, the panel closed, the mode was turned off.
   *
   * Without this, a press whose release went somewhere else would leave the
   * machine armed, and the next space would be read as the release of a hold
   * nobody is doing.
   */
  abort(): HoldAction {
    const was = this.current
    this.current = 'idle'
    this.snapshot = null
    return was === 'listening' ? { kind: 'cancel', swallow: false } : nothing()
  }
}

/**
 * Whether a keyboard event is the plain spacebar.
 *
 * Any modifier means it is a shortcut, not a space - Ctrl+Space and Shift+Space
 * both have other jobs - and a repeat is reported here so the caller does not
 * have to track it twice.
 */
export function isPlainSpace(e: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): boolean {
  return e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
}

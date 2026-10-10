/**
 * Putting the caret in the box, and meaning it.
 *
 * Wumpy opens on a global hotkey, so the foreground belongs to whatever the
 * user was working in and Windows hands it over asynchronously. The main
 * process does its part - app.focus({ steal: true }), win.focus(),
 * webContents.focus() - but the show message still reaches the page before
 * the window actually holds the foreground, and a focus() made in that gap is
 * silently dropped. The keystroke then goes to the editor underneath.
 *
 * This was already known and already "fixed", with one retry on the next
 * animation frame. That is about 16ms. Measured against what Windows actually
 * does, it is nowhere near enough: handing the foreground to a process that
 * was not already there routinely takes 50-250ms, so the retry landed in the
 * same gap as the first attempt and the bug survived the fix.
 *
 * So this keeps trying until it has actually worked, rather than trying twice
 * and hoping. document.hasFocus() is the signal that matters - without it,
 * focusing an element changes which element WOULD receive keys, not where the
 * keys are going.
 */

export interface AttemptState {
  /** Does this window hold the keyboard at all? */
  hasFocus: boolean
  /** Is the element we want already the active one? */
  isActive: boolean
  /** Since the first attempt. */
  elapsedMs: number
  /** Something else owns the keyboard on purpose - a picker, a dialog. */
  yielded: boolean
}

/**
 * Half a second of trying, then stop.
 *
 * Long enough to outlast a slow foreground handover, short enough that it
 * cannot still be stealing focus by the time a person has reacted to the
 * window appearing and clicked somewhere else.
 */
export const FOCUS_DEADLINE_MS = 600

/** How often to try, between frames. Cheap: one focus() call. */
/** A short, readable name for whatever currently holds the caret. */
function describe(el: Element | null): string {
  if (!el || el === document.body) return 'nothing'
  const tag = el.tagName.toLowerCase()
  const cls =
    typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : ''
  return tag + cls
}

export const FOCUS_RETRY_MS = 24

/**
 * Whether to try again.
 *
 * Pure, so the stopping rules can be tested without a window. Four reasons to
 * stop, and only one of them is success.
 */
export function shouldKeepTrying(s: AttemptState): boolean {
  // Someone else is deliberately holding the keyboard. Taking it back would
  // be worse than never having had it.
  if (s.yielded) return false
  // Done: we hold the keyboard and the caret is where it belongs.
  if (s.hasFocus && s.isActive) return false
  // Out of time. The window may be genuinely in the background - the user
  // clicked away - and retrying forever would fight them for it.
  if (s.elapsedMs >= FOCUS_DEADLINE_MS) return false
  return true
}

/**
 * Focus an element and keep insisting until it sticks.
 *
 * Returns a cancel function. Safe to call when the element is not there yet:
 * the getter runs on every attempt, so a late mount is picked up.
 *
 * preventScroll because the composer sits at the bottom of a scrolling
 * transcript, and focusing it the ordinary way yanks a long conversation down
 * to the end - which is not what reopening the panel should do to whatever
 * the user was reading.
 */
export function insistFocus(
  getElement: () => HTMLElement | null | undefined,
  isYielded: () => boolean = () => false,
  /**
   * Called once if the deadline passes and the window still does not hold
   * the keyboard, so the main process can take the foreground by force.
   *
   * The page is the only place that knows. document.hasFocus() is the truth
   * and the main process cannot read it; win.isFocused() is a proxy that can
   * say true while Windows has handed over nothing, which is how an earlier
   * version of this guard came to do nothing at all.
   */
  onGaveUp: () => void = () => {}
): () => void {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const attempt = (): void => {
    if (cancelled) return
    const el = getElement()
    const state: AttemptState = {
      hasFocus: document.hasFocus(),
      isActive: Boolean(el) && document.activeElement === el,
      elapsedMs: Date.now() - startedAt,
      yielded: isYielded()
    }
    if (!shouldKeepTrying(state)) {
      // Out of time without the keyboard, and nobody else wanted it. Ask for
      // the forceful route. Once only - it is called from a loop, and the
      // flicker it causes is not something to repeat.
      if (!state.hasFocus && !state.yielded) {
        /**
         * Says so out loud, because this failure is unreproducible on
         * demand and has come back once already.
         *
         * Everything in the chain is in place and its checks pass - the
         * hook grants the foreground, the window is not a toolbar, the
         * retry uses setTimeout rather than a frame callback - so the next
         * time the keyboard does not arrive, the useful thing is evidence
         * rather than another guess. This line is what turns "it did not
         * focus again" into a measurement.
         */
        console.warn(
          '[wumpy] gave up waiting for the keyboard after ' +
            `${state.elapsedMs}ms: hasFocus=${state.hasFocus} ` +
            `caretHere=${state.isActive} active=${describe(document.activeElement)}`
        )
        onGaveUp()
      }
      return
    }

    // Focus even while the window does not have it: the element then becomes
    // the one Windows lands on when the foreground does arrive, so the very
    // first keystroke is caught rather than the second.
    if (el) el.focus({ preventScroll: true })

    /**
     * setTimeout, deliberately, and never requestAnimationFrame.
     *
     * The panel is hidden until the hotkey, and Chromium stops rAF for a
     * hidden window. Driving the retry from a frame callback meant the loop
     * died after its first attempt - the one that happens before Windows has
     * handed the foreground over, which is the attempt that never works. The
     * window also sets backgroundThrottling: false so these timers are not
     * held back either.
     */
    timer = setTimeout(attempt, FOCUS_RETRY_MS)
  }

  attempt()

  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}

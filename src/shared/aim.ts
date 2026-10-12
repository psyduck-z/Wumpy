/**
 * Clicking the same wrong pixel, over and over, which is what actually
 * happened.
 *
 * From Wumpy's own log, one attempt at "compose an email to Stanley", with
 * the timestamps left in because the shape is the point:
 *
 *   18:30:28  Click at 600, 380   Type "Stanley"   enter   Click 600, 480   paste
 *   18:30:42  Click at 650, 380   Type "Stanley"   enter   Click 650, 480   paste
 *   18:30:49  Click at 500, 310   Type "Stanley"   enter   Click 500, 390   paste
 *   18:30:56  Click at 620, 380   Type "Stanley"   enter   Click 620, 480   paste
 *   18:31:03  Click at 620, 230   Type "Stanley"   enter   Click 620, 290   paste
 *   ... five more, nudged twenty pixels at a time
 *
 * Nothing in the app noticed. Every one of those clicks returned "CLICK ok",
 * because the click did happen - it just happened somewhere that was not the
 * To field. The user's side of it was three empty draft windows and no
 * recipient anywhere.
 *
 * A coordinate is an estimate read off a screenshot that was scaled down, and
 * an estimate that is wrong is wrong identically every time the same picture
 * is looked at. UI Automation is the fix for that, and the model has it - but
 * when it falls back to pixels anyway, this is the thing that says so out
 * loud instead of letting the loop run.
 *
 * Pure, and about points and times only, so the whole rule can be checked
 * without a desktop.
 */

/** One click that was actually sent, in real screen coordinates. */
export interface Aim {
  x: number
  y: number
  at: number
}

/**
 * How close counts as the same place.
 *
 * Thirty pixels, from the log above: the retries moved by twenty and fifty,
 * so a tighter window would have called those different places and a much
 * wider one would start lumping a whole toolbar together.
 */
export const SAME_SPOT = 30

/** How long a click is remembered. A minute is a different conversation. */
export const AIM_WINDOW_MS = 5 * 60_000

/**
 * At what count it stops being a retry and starts being a loop.
 *
 * Three is a real attempt: click, it missed, look again, try the neighbour,
 * try once more. The fourth at the same spot has no new information in it -
 * the same picture is being read the same way - so that is where the step is
 * refused and the model is told to use a name.
 */
export const TOO_MANY = 4

/** How many of the remembered clicks were at this point, recently. */
export function repeats(history: readonly Aim[], x: number, y: number, now: number): number {
  return history.filter(
    (a) => now - a.at <= AIM_WINDOW_MS && Math.hypot(a.x - x, a.y - y) <= SAME_SPOT
  ).length
}

/** The remembered clicks, with this one added and the stale ones dropped. */
export function remember(history: readonly Aim[], aim: Aim, now: number): Aim[] {
  return [...history.filter((a) => now - a.at <= AIM_WINDOW_MS), aim].slice(-40)
}

/**
 * What to say about a click at a place that has been clicked before.
 *
 * Three answers rather than two: nothing at all for the first attempt, a
 * warning that the model can act on while the plan keeps running, and a
 * refusal once the count says the estimate is not improving. The refusal
 * names the alternative, because "stop doing that" without "do this instead"
 * is how a model ends up doing the same thing in a different order.
 */
export function aimNote(
  count: number
): { refuse: false; note: string | null } | { refuse: true; note: string } {
  if (count >= TOO_MANY) {
    return {
      refuse: true,
      note:
        `this exact point has been clicked ${count} times in the last few minutes and the ` +
        'plan is still asking for it, so the estimate is not getting better. Find the ' +
        'control in the list of names and use `press "<name>"`, `focus "<name>"` or ' +
        '`fill "<name>" <text>` instead - those are looked up, not guessed.'
    }
  }
  if (count >= 2) {
    return {
      refuse: false,
      note: `careful: that is the ${count + 1}${count === 2 ? 'rd' : 'nd'} click at this same point. If it did not work the first time, press the control by name instead of nudging the coordinate.`
    }
  }
  return { refuse: false, note: null }
}

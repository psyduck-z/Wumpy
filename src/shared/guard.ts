/**
 * Is somebody else using this computer right now?
 *
 * Asked for in plain terms: "if it detects that it's on the wrong page or
 * like you're interfering make it stop wait or something... Otherwise, I
 * might like mess up some stuff."
 *
 * The helper answers in one line - which window has the keyboard, where the
 * pointer is, how long since the user's own last keystroke and click - and
 * everything in this file is the reading of that line and the decision made
 * from it. Both are pure, which they were not before: the parsing lived in a
 * function that needed a subprocess to call it, so the only thing a check
 * could do was grep the source for the words. That is the wrong kind of test
 * for a regex. A pattern that silently stops matching returns "nothing has
 * happened" forever, which looks exactly like a quiet machine.
 */

/** What the helper reports about the state of the machine. */
export interface Guard {
  hwnd: string
  title: string
  cursorX: number
  cursorY: number
  /** Milliseconds since the user's own last keypress, or -1 for never. */
  keyMs: number
  /** Milliseconds since their own last click or wheel turn, or -1 for never. */
  clickMs: number
  /** What that was: "left-click", "wheel", or "none". */
  clickWhat: string
}

/**
 * Reads a GUARD line, tolerating a helper that reports less than this knows
 * about.
 *
 * The click fields arrived after the rest, and a line without them still has
 * to parse: an older helper beside a newer Wumpy would otherwise fail every
 * guard read, and a failed read means no watching at all rather than less of
 * it. So the strict part stops at keyms and everything after it is looked up
 * on its own.
 */
export function parseGuard(reply: string): Guard | null {
  const m = /^GUARD ok hwnd=(-?\d+) cursor=(-?\d+),(-?\d+) keyms=(-?\d+)/.exec(reply)
  if (!m) return null
  const title64 = /title=(\S*)/.exec(reply)?.[1] ?? ''
  let title = ''
  try {
    title = Buffer.from(title64, 'base64').toString('utf8')
  } catch {
    /* a title we cannot decode is not a reason to refuse to act */
  }
  return {
    hwnd: m[1],
    title,
    cursorX: Number(m[2]),
    cursorY: Number(m[3]),
    keyMs: Number(m[4]),
    clickMs: Number(/clickms=(-?\d+)/.exec(reply)?.[1] ?? -1),
    clickWhat: /\bclick=(\S+)/.exec(reply)?.[1] ?? 'none'
  }
}

/**
 * How far the pointer may drift before it counts as someone using it.
 *
 * A click puts the pointer back where it found it, so between steps it
 * should not move at all. A few pixels is a desk knock or a trackpad resting
 * on a thumb; forty is a hand.
 */
export const POINTER_SLACK = 40

/**
 * Has somebody started using the computer while the plan was running?
 *
 * Stop, not wait. Waiting assumes the interruption is momentary and that the
 * screen will come back to how it was, and neither is knowable from here -
 * the user may have alt-tabbed away for ten minutes, or navigated somewhere
 * the remaining clicks mean something entirely different. The steps that have
 * not run are reported as skipped, the model is told what changed, and it can
 * look again. That is recoverable; typing half an email address into whatever
 * window arrived in the meantime is not.
 */
export function interference(before: Guard, now: Guard, elapsedMs: number): string | null {
  if (now.hwnd !== before.hwnd) {
    const went = now.title.trim()
    return `the foreground window changed${went ? ` to "${went}"` : ''}`
  }
  /* keyMs counts back from now, so a value under the plan's age is a
     keystroke made since it started - and ours are never counted. */
  if (now.keyMs >= 0 && now.keyMs < elapsedMs) return 'you typed something'
  /*
   * And the same for a click, which was the gap in this.
   *
   * A click was the one interruption nothing here could see: it moves the
   * pointer no further than the user's hand already was, presses no key, and
   * changes the focus and often the selection. Someone clicking into a
   * different field while a plan typed was the exact "mess up some stuff"
   * case, and it read as a quiet machine. The helper watches the mouse now.
   */
  if (now.clickMs >= 0 && now.clickMs < elapsedMs) {
    return now.clickWhat === 'wheel' ? 'you scrolled' : 'you clicked something'
  }
  const moved = Math.hypot(now.cursorX - before.cursorX, now.cursorY - before.cursorY)
  if (moved > POINTER_SLACK) return 'the mouse moved'
  return null
}

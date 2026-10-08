/**
 * Things that must happen at most once, remembered outside React.
 *
 * Every card that can act by itself guarded that with a ref - `opened`,
 * `written`, `searched` - and a ref lives and dies with the component
 * instance. Anything that remounts the card hands it a fresh one and the
 * action can happen again: a page opened in two tabs, a file written twice,
 * a search charged twice to a quota.
 *
 * Observed once as a duplicate "Opened duckduckgo.com in your browser." for a
 * single proposal. I could not reproduce it or pin the remount down - React
 * StrictMode does remount every component in development, which would do it
 * exactly, but the build where it happened should have that inert. Since the
 * failure is silent, costs the user something real, and the fix is a few
 * lines, it is guarded structurally rather than left resting on a ref.
 *
 * Keys are per message and per target, so the same page proposed again in a
 * later message is a new decision and opens again, which is right.
 *
 * CommandCard is not here: an unattended command already claims a slot from
 * the app, which survives a remount for the same reason this does.
 */

const claimed = new Set<string>()

/**
 * Takes the claim, or says it was already taken.
 *
 * True means "you are the one doing this". False means someone already did,
 * and the caller should do nothing at all.
 */
export function claimOnce(key: string): boolean {
  if (claimed.has(key)) return false
  claimed.add(key)
  return true
}

/** Whether something has already been done, without taking the claim. */
export function wasClaimed(key: string): boolean {
  return claimed.has(key)
}

/**
 * Forgotten when a conversation is cleared or another is loaded.
 *
 * Without this the set grows for as long as Wumpy is open, and a chat
 * reopened from disk would find its own proposals already claimed and refuse
 * to act on any of them.
 */
export function forgetClaims(): void {
  claimed.clear()
}

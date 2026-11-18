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
/**
 * What a claimed action came to, kept beside the claim for the same reason:
 * a card remounts when its output joins the transcript, and one that had
 * just said "done · 0.3s" came back saying only "already run", output
 * gone - "it always like flickers, and I can't even tell if it's done".
 */
const outcomes = new Map<string, unknown>()

const waiters = new Map<string, Set<() => void>>()

export function rememberOutcome<T>(key: string, outcome: T): void {
  outcomes.set(key, outcome)
  for (const wake of waiters.get(key) ?? []) wake()
  waiters.delete(key)
}

/** Called once the outcome is known: for a card remounted mid-run. */
export function onOutcome(key: string, wake: () => void): () => void {
  const set = waiters.get(key) ?? new Set<() => void>()
  set.add(wake)
  waiters.set(key, set)
  return () => set.delete(wake)
}

export function outcomeOf<T>(key: string): T | undefined {
  return outcomes.get(key) as T | undefined
}

export function forgetClaims(): void {
  outcomes.clear()
  claimed.clear()
}

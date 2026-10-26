import type { GenerationOptions } from '@shared/types'

/**
 * The shape a model client presents to the rest of the app.
 *
 * These types used to live in ollama.ts, and CloudClient was written to match
 * them so that index.ts could pick a client and otherwise not care which one
 * it had. Ollama is gone; the seam is worth keeping anyway, because it is what
 * kept the permission cards, the approval modes, the unattended-run cap and
 * the write-block parsing from knowing anything about providers. A second
 * client - another local runtime, a different hosted shape - still only has to
 * satisfy this.
 */

export interface StreamStats {
  tokensPerSecond?: number
  totalDurationMs?: number
  loadMs?: number
  promptTokens?: number
  completionTokens?: number
  /**
   * Set when the model STOPPED rather than finished: 'length' for the output
   * cap, 'content_filter' for a block.
   *
   * Absent on an ordinary answer, so everything downstream can treat its
   * presence as the whole message. Without it a truncated reply looked
   * exactly like a complete one — same vanished dots, same runtime under it.
   */
  cutOff?: string
}

/**
 * Why a turn failed, in the few categories anything acts on.
 *
 * Matching on the message text was the alternative and it is the kind of thing
 * that works until someone rewords an error. 'limit' is the one that earns
 * this: it is the difference between a turn that is over and a turn another
 * model on the same key could have answered.
 */
export interface StreamFailure {
  /**
   * 'unusable' is a model this provider will not generate with at all.
   *
   * 'blind' is not a failure of the turn, it is a discovery about the model:
   * it was sent a picture and refused it. The caller is expected to lend it
   * the eyes of a model that can see and ask again, which is the whole point
   * of the borrowed eye - so this one is never shown to the user as an
   * error. Nothing had been streamed when it arrives.
   */
  kind: 'limit' | 'auth' | 'network' | 'unusable' | 'blind' | 'other'
  /** True when the same request somewhere else stands a chance. */
  elsewhere: boolean
  /**
   * This model has nothing left today, on any key.
   *
   * Said rather than spelled: the caller used to look for the words "used up
   * its free requests" in the message, which worked until the message was
   * reworded to mention how many keys were out - and then quietly stopped
   * marking the model as spent, so the fallback kept choosing it.
   */
  spent?: boolean
  /**
   * Requests THAT KEY had made on this model when it said it was out.
   *
   * The only credible daily cap available, and it has to come from here
   * because only the sender knows which key was being used. The counter it
   * replaced was the pool's total, which with twenty keys rotating reads
   * twenty times too high - and was then multiplied by twenty again to get a
   * ceiling, so a measured 25-a-day became 10,000 and the meter sat near zero
   * all the way into the wall.
   */
  afterRequests?: number
}

export interface StreamHandlers {
  onDelta(delta: { content?: string; thinking?: string }): void
  onDone(stats: StreamStats): void
  onError(message: string, failure?: StreamFailure): void
}

export interface ChatOptions {
  thinking: boolean
  options: GenerationOptions
  systemPrompt: string
  /** Abort the turn after this long. 0 disables the cap. */
  maxTurnMs: number
}

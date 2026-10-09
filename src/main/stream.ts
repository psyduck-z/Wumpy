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
  /** 'unusable' is a model this provider will not generate with at all. */
  kind: 'limit' | 'auth' | 'network' | 'unusable' | 'other'
  /** True when the same request somewhere else stands a chance. */
  elsewhere: boolean
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

import { CLOUD_MODELS, type Latencies } from './cloud'

/**
 * A spoken question does not wait on a stalled model.
 *
 * "If I just ask it what's 2 plus 3 and it takes 5 seconds, I would have
 * sold it like 12 ages ago." Logged the same evening: "What's two plus
 * three?" took 33,968ms to its first token, on a model the background
 * ranking had measured at 1.1s an hour before. Free hosted models queue,
 * and when they do it is not the question's fault and waiting longer does
 * not help.
 *
 * On a screen a slow start is visible and the reader can pick another
 * model. In the ear it is silence. So a voice turn whose model has said
 * nothing after VOICE_FIRST_TOKEN_MS is asked again on the quickest model
 * the ranking has seen answer - once, and only before anything has been
 * said, so two answers are never stitched together.
 */
export const VOICE_FIRST_TOKEN_MS = 5000

/**
 * The fastest model that answered its last check, other than `model`,
 * that can be used right now and is still offered. Slower than half the
 * patience is no rescue, so those are left out. Null when there is none.
 */
export function quickerModel(model: string, latencies: Latencies, usable: (id: string) => boolean): string | null {
  let best: string | null = null
  let bestMs = VOICE_FIRST_TOKEN_MS / 2
  for (const [id, fresh] of Object.entries(latencies)) {
    if (id === model || !fresh.ok || fresh.ms >= bestMs) continue
    if (!CLOUD_MODELS.some((m) => m.id === id) || !usable(id)) continue
    best = id
    bestMs = fresh.ms
  }
  return best
}

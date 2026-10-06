import { useEffect, useRef, useState } from 'react'

/**
 * How far behind the incoming stream the reveal aims to sit, in ms.
 *
 * Draining the backlog over a fixed window is self-balancing: at a steady
 * arrival rate A the backlog settles at A x LEAD and the reveal rate settles at
 * exactly A. A wider window buys smoother spacing at the cost of trailing
 * further behind the model.
 *
 * Tuned against captured token timings (llama3.2:3b, ~19 chars/s), scoring gap
 * jitter as a coefficient of variation — lower is smoother:
 *
 *   render on arrival                 2.19   lag    0ms
 *   LEAD 500, no floor                0.437  lag  497ms
 *   LEAD 400 + floor 0.7              0.428  lag  376ms   <- shipped
 *   LEAD 650 + floor 0.85             0.384  lag  548ms
 *
 * 400 is the knee: it is both smoother and 120ms less laggy than 500. Going
 * wider buys very little evenness for real lag.
 */
const LEAD_MS = 400

/** Once the stream ends, drain what is left this fast instead of snapping. */
const FLUSH_MS = 110

/**
 * Keep revealing at least this fraction of the measured arrival rate while the
 * stream is live. A model pause then becomes a gentle slowdown rather than a
 * dead stop, which is what the eye reads as stutter.
 */
const RATE_FLOOR = 0.7

/** Time constant for the arrival-rate estimate, in ms. */
const EMA_TAU = 800

/**
 * Characters per second, floor and ceiling.
 *
 * The absolute floor must stay *below* the slowest realistic arrival rate.
 * Setting it above (28/s against ~19/s arrival) makes the reveal outrun its own
 * buffer and stall ~760 times a message — worse than no smoothing at all.
 */
const MIN_RATE = 4
const MAX_RATE = 1500

/**
 * Progressively reveals `target`, decoupling display from arrival.
 *
 * Ollama does not trickle characters: it emits a whole token roughly every
 * 300ms, around six characters at a time. Rendering each as it lands is what
 * makes text appear in lumps. This buffers them and releases characters on an
 * animation frame instead, at a rate derived from how much is waiting and how
 * fast text has been arriving.
 *
 * The one gap it cannot smooth is the one after the very first character, since
 * no buffer exists yet. Everything after that holds a p95 gap of ~83ms.
 *
 * Returns the text to display plus whether it is still catching up, so the
 * caller can keep a caret on screen after the network stream has finished.
 */
export function useSmoothText(
  target: string,
  streaming: boolean,
  enabled: boolean
): [string, boolean] {
  const reduceMotion = usePrefersReducedMotion() || !enabled

  // Messages already complete when first rendered (history, saved chats) must
  // not animate from nothing.
  const [revealed, setRevealed] = useState(() => (streaming ? 0 : target.length))

  const targetRef = useRef(target)
  const streamingRef = useRef(streaming)
  const revealedRef = useRef(revealed)
  /** Sub-character progress carried between frames, so slow rates still move. */
  const remainder = useRef(0)
  /** Smoothed arrival rate in chars/sec, used for the soft floor. */
  const arrivalRate = useRef(0)
  const lastLength = useRef(target.length)
  const lastFrame = useRef(0)
  const lastCommit = useRef(0)

  targetRef.current = target
  streamingRef.current = streaming

  // A shorter target means a different message is in this slot; start over.
  if (target.length < revealedRef.current) {
    revealedRef.current = target.length
    remainder.current = 0
  }

  useEffect(() => {
    if (reduceMotion) return
    // Nothing to reveal: do not start a loop at all. Without this guard every
    // finished message kept a 60fps callback alive for the life of the chat,
    // which measured 36% of a core with the panel merely open.
    if (revealedRef.current >= targetRef.current.length) return

    let frame = 0

    const tick = (now: number): void => {
      const dt = lastFrame.current ? Math.min(now - lastFrame.current, 100) : 16
      lastFrame.current = now

      const total = targetRef.current.length

      // Exponential moving average of how fast characters are arriving.
      const instant = ((total - lastLength.current) * 1000) / dt
      lastLength.current = total
      arrivalRate.current += (instant - arrivalRate.current) * (1 - Math.exp(-dt / EMA_TAU))

      const backlog = total - revealedRef.current
      if (backlog <= 0) {
        // Caught up. Stop; a new token restarts the effect.
        remainder.current = 0
        lastFrame.current = 0
        return
      }

      // Drain the backlog over the lead window; a burst speeds the reveal up and
      // a trickle slows it down.
      let rate = (backlog * 1000) / (streamingRef.current ? LEAD_MS : FLUSH_MS)
      if (streamingRef.current) {
        rate = Math.max(rate, arrivalRate.current * RATE_FLOOR)
      }
      rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate))

      const advance = (rate * dt) / 1000 + remainder.current
      // Show the first character as soon as it exists. Easing into it would give
      // back the time-to-first-word that keeping models warm bought.
      const whole =
        revealedRef.current === 0 ? Math.max(1, Math.floor(advance)) : Math.floor(advance)
      remainder.current = Math.max(0, advance - whole)

      if (whole > 0) {
        revealedRef.current = Math.min(total, revealedRef.current + whole)

        // Re-rendering markdown is the expensive part, so commit less often for
        // long messages. Short ones update every frame and feel liquid.
        const minInterval = total > 4000 ? 32 : total > 1500 ? 24 : 0
        if (now - lastCommit.current >= minInterval || revealedRef.current === total) {
          lastCommit.current = now
          setRevealed(revealedRef.current)
        }
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // `target` is a dependency on purpose: each arriving token restarts the
    // loop, and a message that is fully revealed never starts one.
  }, [target, streaming, reduceMotion])

  if (reduceMotion) return [target, false]

  return [target.slice(0, revealed), revealed < target.length]
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const onChange = (): void => setReduce(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduce
}

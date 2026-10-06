import { useEffect, useRef, useState } from 'react'

/**
 * How far behind the incoming stream the reveal aims to sit, in ms.
 *
 * Draining the backlog over a fixed window is self-balancing: at a steady
 * arrival rate A, the backlog settles at A x LEAD and the reveal rate settles
 * at exactly A. A wider window buys a bigger cushion and smoother spacing at
 * the cost of trailing further behind.
 *
 * Measured against real token timings (llama3.2:3b at ~19 chars/s), gap jitter
 * as a coefficient of variation — lower is smoother:
 *
 *   render on arrival   2.19   (p95 gap 329ms, max 387ms)
 *   LEAD 260            0.54
 *   LEAD 500            0.38   (p95 gap  83ms, max 200ms)
 *   LEAD 650            0.34   — diminishing, and visibly lags the model
 */
const LEAD_MS = 500

/** Once the stream ends, drain what is left this fast instead of snapping. */
const FLUSH_MS = 110

/**
 * Characters per second, floor and ceiling.
 *
 * The floor must stay *below* the slowest realistic arrival rate. Setting it
 * above (28/s against ~19/s arrival) makes the reveal outrun the buffer and
 * stall ~760 times a message, which is the stutter this hook exists to remove.
 */
const MIN_RATE = 5
const MAX_RATE = 1200

/**
 * Progressively reveals `target`, decoupling display from arrival.
 *
 * Ollama delivers whole tokens about eight times a second, so rendering each
 * one as it lands makes text appear in visible lumps. This buffers them and
 * releases characters on an animation frame instead, at a rate derived from how
 * much is waiting — fast when it is behind, gentle when it has caught up.
 *
 * Returns the text to display plus whether it is still catching up, so the
 * caller can keep a caret on screen after the network stream has finished.
 */
export function useSmoothText(target: string, streaming: boolean): [string, boolean] {
  const reduceMotion = usePrefersReducedMotion()

  // Messages that are already complete when first rendered (history, saved
  // chats) must not animate from nothing.
  const [revealed, setRevealed] = useState(() => (streaming ? 0 : target.length))

  const targetRef = useRef(target)
  const streamingRef = useRef(streaming)
  const revealedRef = useRef(revealed)
  /** Sub-character progress carried between frames, so slow rates still move. */
  const remainder = useRef(0)
  const lastFrame = useRef(0)
  const lastCommit = useRef(0)
  const raf = useRef(0)

  targetRef.current = target
  streamingRef.current = streaming

  // A shorter target means a different message is in this slot; start over.
  if (target.length < revealedRef.current) {
    revealedRef.current = target.length
    remainder.current = 0
  }

  useEffect(() => {
    if (reduceMotion) return

    const tick = (now: number): void => {
      const dt = lastFrame.current ? Math.min(now - lastFrame.current, 100) : 16
      lastFrame.current = now

      const total = targetRef.current.length
      const backlog = total - revealedRef.current

      if (backlog <= 0) {
        // Nothing waiting: idle until new text arrives.
        remainder.current = 0
        raf.current = requestAnimationFrame(tick)
        return
      }

      // Drain the backlog over the lead window, so a burst of tokens speeds the
      // reveal up and a trickle slows it down.
      const window = streamingRef.current ? LEAD_MS : FLUSH_MS
      const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, (backlog * 1000) / window))

      const advance = (rate * dt) / 1000 + remainder.current
      // Show the first character as soon as it exists. Easing into it would
      // give back the time-to-first-word that keeping models warm bought.
      const whole = revealedRef.current === 0 ? Math.max(1, Math.floor(advance)) : Math.floor(advance)
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

      raf.current = requestAnimationFrame(tick)
    }

    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [reduceMotion])

  if (reduceMotion) return [target, false]

  const shown = target.slice(0, revealed)
  return [shown, revealed < target.length]
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

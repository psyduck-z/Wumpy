import { memo, useEffect, useMemo, useState } from 'react'
import type { Mode } from '@shared/types'

/** How often digits flip, in ms. Low enough to read as rapid churn. */
const FLICKER_MS = 110
/** Fraction of a strand's digits that change per tick. */
const FLICKER_SHARE = 0.35
/** Horizontal spacing between strands, in px. */
const COLUMN_PITCH = 44

function randomDigits(n: number): string[] {
  return Array.from({ length: n }, () => (Math.random() < 0.5 ? '0' : '1'))
}

interface Strand {
  /** Which column this strand falls down. */
  column: number
  length: number
  duration: number
  delay: number
  opacity: number
}

/** Strands per column. Two keeps the field populated without crowding it. */
const STRANDS_PER_COLUMN = 2

/**
 * Developer-mode backdrop: segmented strands of binary falling behind the
 * content, each with a bright leading glyph and a tail that fades out behind it.
 *
 * Deliberately cheap. Each strand falls on a single CSS transform, which the
 * compositor handles on the GPU, and the churn mutates characters in an array
 * rather than animating hundreds of elements. Nothing here should take cycles
 * away from inference.
 */
const BinaryRain = memo(function BinaryRain({
  columns,
  fall
}: {
  columns: number
  fall: number
}) {
  // Randomised once per layout so strands never fall in lockstep.
  const strands = useMemo<Strand[]>(
    () =>
      Array.from({ length: columns * STRANDS_PER_COLUMN }, (_, i) => ({
        column: i % columns,
        length: 9 + Math.floor(Math.random() * 12),
        duration: 4.5 + Math.random() * 6,
        // Negative delays spread across a cycle, so strands are already
        // mid-fall on the first frame instead of all entering together.
        delay: -Math.random() * 10,
        opacity: 0.45 + Math.random() * 0.55
      })),
    [columns]
  )

  const [digits, setDigits] = useState<string[][]>(() => strands.map((s) => randomDigits(s.length)))

  useEffect(() => {
    setDigits(strands.map((s) => randomDigits(s.length)))
  }, [strands])

  useEffect(() => {
    const timer = setInterval(() => {
      // Flip a scattering of glyphs per strand so individual digits churn,
      // rather than the whole field changing at once.
      setDigits((prev) =>
        prev.map((strand) => {
          const next = strand.slice()
          const flips = Math.max(1, Math.round(next.length * FLICKER_SHARE))
          for (let i = 0; i < flips; i++) {
            const at = Math.floor(Math.random() * next.length)
            next[at] = next[at] === '0' ? '1' : '0'
          }
          return next
        })
      )
    }, FLICKER_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="rain" aria-hidden="true" style={{ ['--fall' as string]: `${fall}px` }}>
      {strands.map((s, i) => {
        const glyphs = digits[i] ?? []
        const head = glyphs[glyphs.length - 1] ?? '0'
        const tail = glyphs.slice(0, -1).join('\n')
        return (
          <span
            className="strand"
            key={i}
            style={{
              // Positioned rather than flex-laid-out, so two strands can share
              // a column without competing for the same box.
              left: `${(s.column / columns) * 100}%`,
              width: `${100 / columns}%`,
              animationDuration: `${s.duration}s`,
              animationDelay: `${s.delay}s`,
              opacity: s.opacity
            }}
          >
            {tail}
            {'\n'}
            <b className="strand-head">{head}</b>
          </span>
        )
      })}
    </div>
  )
})

/**
 * Background texture for the panel, picked by mode: a single highlight sweep a
 * beat after the panel opens in Quick mode, falling binary in Developer mode.
 * Sits behind the content and never takes pointer events.
 */
export function Ambience({
  mode,
  active,
  openCount
}: {
  mode: Mode
  active: boolean
  /** Changes on each summon; keys the one-shot sweep so it replays. */
  openCount: number
}): React.JSX.Element | null {
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  const [metrics, setMetrics] = useState({ columns: 10, fall: 900 })
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const onChange = (): void => setReduceMotion(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const measure = (): void =>
      setMetrics({
        columns: Math.max(5, Math.round(window.innerWidth / COLUMN_PITCH)),
        // Strands travel the full height of the window plus their own length.
        fall: window.innerHeight
      })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Nothing animates while the panel is hidden; there is no one to see it.
  if (reduceMotion || !active) return null

  if (mode === 'dev') return <BinaryRain columns={metrics.columns} fall={metrics.fall} />

  // Keyed on the open count so the one-shot sweep restarts every time the panel
  // is summoned, a second after it settles.
  return <div className="shine" key={openCount} aria-hidden="true" />
}

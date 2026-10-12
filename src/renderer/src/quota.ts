import type { PoolView } from '@shared/pool'

/**
 * The key pool, written out for someone who asked how much they have left.
 *
 * Pure, so the awkward cases - no cap known, every key out, one key, a reset
 * eight hours away - can be read off a check rather than waited for. The
 * numbers are positions in the list, which is how the log lines name keys
 * too ("key 4/20"); nothing here is derived from a key's value.
 *
 * Asked for as "make it easier to navigate the quota, make it more
 * accurate". The accuracy is in pool.ts; this is the navigating.
 */

/** "4", "4 and 11", "4, 11 and 19" — a list a person reads aloud. */
export function keyList(numbers: number[]): string {
  if (numbers.length === 0) return ''
  if (numbers.length === 1) return `${numbers[0]}`
  const head = numbers.slice(0, -1).join(', ')
  return `${head} and ${numbers[numbers.length - 1]}`
}

/** "in 45s", "in 12 min", "in 7h 12m" — no unit anyone has to convert. */
export function untilText(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  if (seconds < 90) return `in ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function poolLines(pool: PoolView, now: number = Date.now()): string[] {
  if (pool.keys <= 0) return []

  const keyWord = pool.keys === 1 ? 'key' : 'keys'
  const lines: string[] = [
    `**${pool.model}** — ${pool.ready} of ${pool.keys} ${keyWord} ready`
  ]

  /*
   * The headline number. "cap unknown" is said out loud rather than shown as
   * an empty meter, because most of these models have no published daily
   * limit worth trusting and a confident wrong ceiling is worse than none.
   */
  if (pool.remaining !== null) {
    lines.push(
      `About **${pool.remaining.toLocaleString()}** of ${pool.cap.toLocaleString()} requests ` +
        `left today (${pool.perKeyCap} per key x ${pool.keys}), ` +
        `${pool.requests} used.`
    )
  } else {
    lines.push(
      `${pool.requests} request${pool.requests === 1 ? '' : 's'} today. ` +
        'No daily cap worth trusting is known for this model yet — ' +
        'the first time a key runs out, that count becomes the cap.'
    )
  }

  const out = pool.rows.filter((r) => r.state === 'out').map((r) => r.number)
  const resting = pool.rows.filter((r) => r.state === 'resting').map((r) => r.number)

  if (out.length) {
    lines.push(
      `Out until the reset: ${out.length === 1 ? 'key' : 'keys'} ${keyList(out)} ` +
        `(${clock(pool.resetAt)}, ${untilText(pool.resetAt - now)}).`
    )
  }
  if (resting.length) {
    const soonest = Math.min(...pool.rows.filter((r) => r.state === 'resting').map((r) => r.untilMs))
    lines.push(
      `Catching breath: ${resting.length === 1 ? 'key' : 'keys'} ${keyList(resting)} ` +
        `(back ${untilText(soonest - now)}).`
    )
  }
  if (!out.length && !resting.length) {
    lines.push(`Every key can answer. The day's allowance resets at ${clock(pool.resetAt)}.`)
  }
  if (pool.ready === 0) {
    lines.push(
      pool.nextFreeMs > 0
        ? `**Nothing can answer right now** — the soonest is back ${untilText(pool.nextFreeMs)}.`
        : '**Nothing can answer right now.**'
    )
  }

  /*
   * Only the keys that have done something, because twenty rows of zero is
   * not a report. Sorted by spend so the ones near their limit are at the
   * top, which is the order someone deciding whether to keep going wants.
   */
  const busy = pool.rows
    .filter((r) => r.requests > 0 || r.state !== 'ready')
    .sort((a, b) => b.requests - a.requests || a.number - b.number)
    .slice(0, 8)
  if (busy.length) {
    lines.push('')
    lines.push('| key | requests | state |')
    lines.push('| --- | --- | --- |')
    for (const row of busy) {
      const state =
        row.state === 'out'
          ? `out for the day`
          : row.state === 'resting'
            ? `resting, back ${untilText(row.untilMs - now)}`
            : 'ready'
      const left = pool.perKeyCap ? ` / ${pool.perKeyCap}` : ''
      lines.push(`| ${row.number} | ${row.requests}${left} | ${state} |`)
    }
  }

  return lines
}

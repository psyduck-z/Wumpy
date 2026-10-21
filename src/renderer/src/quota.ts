import type { PoolView } from '@shared/pool'
import { providerFor } from '@shared/cloud'

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

/**
 * `/key nvidia` for an NVIDIA model, and never `/key google` for one.
 *
 * These lines used to name google outright, because google was the only
 * provider with a pool worth reporting on. After the move to NVIDIA they
 * still did: a refused NVIDIA key printed "drop them with `/key google drop
 * 3`", which is a command that acts on a different provider's list - or on
 * an empty one - while the key it was complaining about stays exactly where
 * it was. Advice that names the wrong provider is worse than none, because
 * it gets followed.
 *
 * The model is the only thing a PoolView carries, so the provider comes
 * from the catalogue. A hand-typed model id that routes nowhere gets the
 * placeholder, which reads as something to fill in rather than as a command
 * to paste.
 */
export function keyCommandFor(model: string): string {
  const provider = providerFor(model)
  return provider ? `/key ${provider}` : '/key <provider>'
}

export function poolLines(pool: PoolView, now: number = Date.now()): string[] {
  if (pool.keys <= 0) return []

  const keyWord = pool.keys === 1 ? 'key' : 'keys'
  const lines: string[] = [
    `**${pool.model}** — ${pool.ready} of ${pool.keys} ${keyWord} ready` +
      (pool.rejected ? `, ${pool.rejected} refused` : '')
  ]

  /*
   * The headline number. "cap unknown" is said out loud rather than shown as
   * an empty meter, because most of these models have no published daily
   * limit worth trusting and a confident wrong ceiling is worse than none.
   */
  if (pool.remaining !== null) {
    /*
     * How the ceiling was arrived at, which is a different sentence
     * depending on the provider and must not be guessed from the figures:
     * "25 per key x 20" and "25 shared across 20 keys" print the same two
     * numbers and mean opposite things. Only Google's keys each carry an
     * allowance; an NVIDIA key is a door into the account's one budget.
     */
    const how =
      pool.perKeyQuota && pool.keys > 1
        ? `${pool.perKeyCap} per key x ${pool.keys}`
        : pool.keys > 1
          ? `shared across all ${pool.keys} keys`
          : `${pool.perKeyCap} a day`
    lines.push(
      `About **${pool.remaining.toLocaleString()}** of ${pool.cap.toLocaleString()} requests ` +
        `left today (${how}), ${pool.requests} used.`
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
  const dead = pool.rows.filter((r) => r.state === 'rejected').map((r) => r.number)

  /*
   * First, because it is the only state that needs the user to do something.
   * Waiting does not fix a rejected key and neither does tomorrow. Three of
   * the twenty on this machine had been refused for weeks with nothing
   * saying so, which is the whole reason this line exists.
   */
  if (dead.length) {
    const key = keyCommandFor(pool.model)
    /* Four sentences once, listing causes the reader cannot act on
       differently. What they need is which key, that waiting is not the
       answer, and the two commands. */
    lines.push(
      `**${dead.length === 1 ? 'Key' : 'Keys'} ${keyList(dead)} refused** — waiting will not fix ` +
        `${dead.length === 1 ? 'it' : 'them'}, and ${dead.length === 1 ? 'it is' : 'they are'} ` +
        'left out of the figures above. ' +
        `\`${key} drop ${dead.join(' ')}\` to remove, or \`${key} check\` to retry free.`
    )
  }

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
  /* "Every key can answer" with three of them refused was the old reading,
     and it is the sentence this whole fix exists to stop. */
  if (!out.length && !resting.length && !dead.length) {
    lines.push(`Every key can answer. The day's allowance resets at ${clock(pool.resetAt)}.`)
  } else if (!out.length && !resting.length) {
    /* "The other 1 can answer" is what a counter writes, not a person.
       The number is already on the first line. */
    lines.push(
      `The ${pool.ready === 1 ? 'other one' : `other ${pool.ready}`} can answer. ` +
        `Resets at ${clock(pool.resetAt)}.`
    )
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
        row.state === 'rejected'
          ? 'refused — replace it'
          : row.state === 'out'
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

/**
 * Skills on every device: "if I create a good skill on one device, I can
 * also access it on another device".
 *
 * Through an unlisted gist on their own GitHub account - one file per
 * skill, and a manifest saying when each was last changed and which were
 * deleted. Both devices sign in as the same account and find the same gist
 * by its description, so there is nothing to pair.
 *
 * A two-way sync against the last state both sides agreed on (the base):
 * what changed on one side only goes to the other; a skill deleted on one
 * side is deleted on the other; changed on both, the newer wins - and a
 * deletion never beats an edit, so nothing written is lost to a conflict.
 * Untouched shipped skills are not synced: every Wumpy has them already.
 *
 * Pure, for scripts/check-skillsync.mjs.
 */

/** The gist's description, which is how every device finds it. */
export const GIST_DESCRIPTION = 'Wumpy skills (synced by Wumpy - one file per skill)'
export const MANIFEST = 'wumpy-skills.json'
export const README = 'README.md'

/** The gist file a skill is kept in: gist files cannot have folders. */
export const gistFile = (name: string): string => `${name}.SKILL.md`
export const nameOfGistFile = (file: string): string | null => /^([a-z0-9-]+)\.SKILL\.md$/.exec(file)?.[1] ?? null

export interface Version {
  hash: string
  /** ms: when it last changed. */
  at: number
}

export interface Manifest {
  version: 1
  /** Every skill the gist knows of; deleted ones are kept as a tombstone. */
  skills: Record<string, Version & { deleted?: true }>
}

export type Step = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' | 'same'

/**
 * What to do with each skill.
 *
 * `base` is what both sides held after the last sync, by name: a hash, or
 * null for "deleted then". A name not in it has never been synced.
 */
export function plan(
  local: Record<string, Version>,
  remote: Manifest['skills'],
  base: Record<string, string | null>
): Record<string, Step> {
  const out: Record<string, Step> = {}
  const names = new Set([...Object.keys(local), ...Object.keys(remote)])
  for (const name of names) {
    const L = local[name] ?? null
    const r = remote[name]
    const R = r && !r.deleted ? r : null
    const lh = L?.hash ?? null
    const rh = R?.hash ?? null
    if (lh === rh) {
      out[name] = 'same'
      continue
    }
    const known = name in base
    const b = known ? base[name] : undefined
    const localChanged = !known || lh !== b
    const remoteChanged = !known || rh !== b
    if (localChanged && !remoteChanged) out[name] = L ? 'upload' : 'deleteRemote'
    else if (remoteChanged && !localChanged) out[name] = R ? 'download' : 'deleteLocal'
    /* Both changed. An edit beats a deletion; between two edits, the newer. */
    else if (!R) out[name] = 'upload'
    else if (!L) out[name] = 'download'
    else out[name] = L.at >= R.at ? 'upload' : 'download'
  }
  return out
}

/** A manifest read from the gist, or an empty one for anything that is not. */
export function readManifest(text: string | undefined | null): Manifest {
  try {
    const m = JSON.parse(text ?? '') as Manifest
    if (m && m.version === 1 && m.skills && typeof m.skills === 'object') return m
  } catch {
    /* A new gist, or one somebody edited by hand: start from nothing. */
  }
  return { version: 1, skills: {} }
}

/** What the sync did, in a line. */
export function summary(steps: Record<string, Step>): { up: string[]; down: string[]; gone: string[]; line: string } {
  const pick = (...s: Step[]): string[] => Object.keys(steps).filter((n) => s.includes(steps[n])).sort()
  const up = pick('upload', 'deleteRemote')
  const down = pick('download')
  const gone = pick('deleteLocal')
  const parts = [
    down.length ? `got ${list(down)} from your other devices` : '',
    gone.length ? `removed ${list(gone)}, deleted on another device` : '',
    up.length ? `shared ${list(up)}` : ''
  ].filter(Boolean)
  return { up, down, gone, line: parts.length ? parts.join('; ') : 'already the same everywhere' }
}

function list(names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `/${n}`)
  return names.length > 5 ? `${shown.join(', ')} and ${names.length - 5} more` : shown.join(', ')
}

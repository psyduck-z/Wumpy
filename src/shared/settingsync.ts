/**
 * Settings on every paired device: "you can sync your settings to the other
 * devices too".
 *
 * They ride along with the skills over Wi-Fi as "@settings" (main/lansync.ts),
 * never to GitHub. Each setting carries when it was last changed, and the
 * merge is setting by setting: the model changed on the laptop and thinking
 * turned on at the desk both survive, because neither is a newer version of
 * the other.
 *
 * Not everything is shared. What belongs to one machine stays there: where
 * the panel docks and how big it is (screens differ), the hotkeys (Windows
 * and Linux take different ones), starting at login, the folder commands run
 * in, dictation itself (one has a microphone, one may not), the keys and the
 * latencies measured on that connection. And so do the permissions -
 * whether commands run without asking - because "everything runs, nothing
 * asks" arriving on a machine from another one is a change nobody made on
 * that machine. The sync switches themselves stay put too.
 *
 * Pure, for scripts/check-lanmesh.mjs.
 */
import { DEFAULT_SETTINGS } from './defaults'
import { isOrdering } from './order'
import { RANK_EVERY_MIN } from './ranking'
import type { WumpySettings } from './types'

/** Its name in the sync: not a skill name, which cannot start with @. */
export const SHARED_SETTINGS = '@settings'

/** The settings that follow them from device to device. */
export const SHARED_KEYS = [
  'model',
  'hideOnBlur',
  'autoSave',
  'autoCompact',
  'showReasoning',
  'smoothText',
  'maxTurnMs',
  'shellEnabled',
  'thinking',
  'searchEnabled',
  'apiFallback',
  'voicePolish',
  'voiceAutoStop',
  'voiceCloud',
  'speakVoice',
  'speakRate',
  'pauseMusic',
  'reflect',
  'reflectRounds',
  'reflectModel',
  'leanPrompt',
  'browserEnabled',
  'screenEnabled',
  'searchEngine',
  'modelOrder',
  'autoRank',
  'rankEveryMin'
] as const satisfies ReadonlyArray<keyof WumpySettings>

export type SharedKey = (typeof SHARED_KEYS)[number]
const SHARED = new Set<string>(SHARED_KEYS)

/** When each shared setting last changed, in ms; a setting never changed is not in it. */
export type Stamps = Partial<Record<SharedKey, number>>

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The first time, before anything was stamped: whatever differs from the default, as of `at`. */
export function firstStamps(current: WumpySettings, at: number): Stamps {
  const out: Stamps = {}
  for (const k of SHARED_KEYS) if (!same(current[k], DEFAULT_SETTINGS[k])) out[k] = at
  return out
}

/** Stamps the shared settings that changed between two versions; true if any did. */
export function stampChanges(prev: WumpySettings, next: WumpySettings, stamps: Stamps, now: number): boolean {
  let any = false
  for (const k of SHARED_KEYS) {
    if (same(prev[k], next[k])) continue
    stamps[k] = now
    any = true
  }
  return any
}

/** The shared settings as the sync carries them, or null when none was ever changed. */
export function shareText(current: WumpySettings, stamps: Stamps): { text: string; at: number } | null {
  const keys = SHARED_KEYS.filter((k) => (stamps[k] ?? 0) > 0).sort()
  if (!keys.length) return null
  const s: Record<string, [unknown, number]> = {}
  for (const k of keys) s[k] = [current[k], stamps[k] as number]
  return { text: JSON.stringify({ v: 1, s }), at: Math.max(...keys.map((k) => stamps[k] as number)) }
}

/** Whether a value from another device is one this setting can hold. */
function fitting(k: SharedKey, v: unknown): boolean {
  const d = DEFAULT_SETTINGS[k]
  if (typeof v !== typeof d) return false
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return false
    if (k === 'speakRate') return v >= 0.5 && v <= 3
    if (k === 'reflectRounds') return Number.isInteger(v) && v <= 10
    if (k === 'maxTurnMs') return v >= 10_000 && v <= 60 * 60_000
    if (k === 'rankEveryMin') return Number.isInteger(v) && v >= RANK_EVERY_MIN.least && v <= RANK_EVERY_MIN.most
  }
  if (typeof v === 'string') {
    if (v.length > 200 || /[\u0000-\u001f]/.test(v)) return false
    if (k === 'modelOrder') return isOrdering(v)
    if (k === 'model') return v.length > 0
  }
  return true
}

/** Settings from another device, checked: only shared ones, each a value it can hold. Null for anything else. */
export function readShared(text: string, now = Date.now()): Partial<Record<SharedKey, { v: unknown; at: number }>> | null {
  let o: { v?: unknown; s?: unknown }
  try {
    o = JSON.parse(text) as typeof o
  } catch {
    return null
  }
  if (!o || o.v !== 1 || !o.s || typeof o.s !== 'object') return null
  const out: Partial<Record<SharedKey, { v: unknown; at: number }>> = {}
  for (const [k, pair] of Object.entries(o.s as Record<string, unknown>)) {
    if (!SHARED.has(k) || !Array.isArray(pair) || pair.length !== 2) continue
    const [v, at] = pair as [unknown, unknown]
    /* A day ahead at most: a clock far in the future would win every setting forever. */
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now + 86_400_000) continue
    if (!fitting(k as SharedKey, v)) continue
    out[k as SharedKey] = { v, at }
  }
  return out
}

/** Which of two versions of one setting wins: the newer, and on a tie the same one on both devices. */
function wins(theirs: { v: unknown; at: number }, mine: { v: unknown; at: number }): boolean {
  if (theirs.at !== mine.at) return theirs.at > mine.at
  return JSON.stringify(theirs.v) > JSON.stringify(mine.v)
}

/**
 * Another device's settings into these, setting by setting: what it changed
 * more recently is taken, with its time, so both end up the same.
 */
export function merge(
  current: WumpySettings,
  stamps: Stamps,
  incoming: Partial<Record<SharedKey, { v: unknown; at: number }>>
): { patch: Partial<WumpySettings>; stamps: Stamps; changed: SharedKey[] } {
  const patch: Record<string, unknown> = {}
  const next: Stamps = { ...stamps }
  const changed: SharedKey[] = []
  for (const k of SHARED_KEYS) {
    const theirs = incoming[k]
    if (!theirs) continue
    if (!wins(theirs, { v: current[k], at: stamps[k] ?? 0 })) continue
    next[k] = theirs.at
    if (!same(current[k], theirs.v)) {
      patch[k] = theirs.v
      changed.push(k)
    }
  }
  return { patch: patch as Partial<WumpySettings>, stamps: next, changed }
}

/** "model, thinking" in words they would recognise. */
export function settingWords(keys: readonly SharedKey[]): string {
  const words: Partial<Record<SharedKey, string>> = {
    model: 'the model',
    thinking: 'thinking',
    speakVoice: 'the voice',
    speakRate: 'speaking speed',
    searchEngine: 'the search engine',
    modelOrder: 'the model order',
    hideOnBlur: 'hide on click-away',
    voicePolish: 'tidy up dictation',
    voiceAutoStop: 'stop at a pause',
    pauseMusic: 'pause music',
    reflect: 'reflect',
    autoRank: 're-ranking',
    rankEveryMin: 'how often it re-ranks',
    shellEnabled: 'commands',
    browserEnabled: 'opening pages',
    screenEnabled: 'looking at the screen'
  }
  const shown = keys.slice(0, 4).map((k) => words[k] ?? k)
  return keys.length > 4 ? `${shown.join(', ')} and ${keys.length - 4} more` : shown.join(', ')
}

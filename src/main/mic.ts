/**
 * Which microphone a voice turn or a dictation opens.
 *
 * Reported in these words: "sometimes the mic takes time to like get picked
 * up." The system default here is the earbuds' microphone, and earbuds only
 * have one in their headset (HFP) mode. Opening it makes the audio system
 * drop them out of high-quality A2DP and into headset mode, which takes
 * seconds - and on this machine's Bluetooth sometimes fails outright,
 * logged as "Failure in Bluetooth audio transport" and retried. Two of three
 * turns in a row heard pure silence (loudest 0.000) while that happened.
 *
 * So, by default ('auto'), when the default microphone is a Bluetooth
 * headset's and the computer has one of its own, the computer's is used: no
 * switch, no wait, nothing to fail, and the earbuds stay in A2DP so the
 * spoken answer sounds as good as music does. `/microphone earbuds` goes back to the
 * system default, for talking from across the room; `/microphone <number>` picks
 * one by name.
 *
 * Only Linux can tell, through pactl (PipeWire's Pulse interface, always
 * there on Omarchy). Elsewhere 'auto' is the system default.
 */
import { execFile } from 'node:child_process'

export interface MicPlan {
  /** The device label to open, as the page sees it; null is the system default. */
  label: string | null
  /** Why, in a few words, for the log and for /microphone. */
  why: string
}

function pactl(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** 'auto', 'default', or a device label chosen with /microphone. */
export async function micPlan(choice: string | undefined): Promise<MicPlan> {
  const pick = (choice ?? 'auto').trim() || 'auto'
  if (pick === 'default') return { label: null, why: 'the system default (/microphone earbuds)' }
  if (pick !== 'auto') return { label: pick, why: 'chosen with /microphone' }
  if (process.platform !== 'linux') return { label: null, why: 'the system default' }

  const fallback = await pactl(['get-default-source'])
  const current = fallback.trim()
  if (!current.startsWith('bluez_')) return { label: null, why: 'the system default, which is not Bluetooth' }

  let sources: Array<{ name?: string; description?: string }> = []
  try {
    sources = JSON.parse(await pactl(['-f', 'json', 'list', 'sources']))
  } catch {
    return { label: null, why: 'the system default (the microphones could not be listed)' }
  }
  const own = sources.find(
    (s) => s.name && s.description && !s.name.endsWith('.monitor') && !s.name.startsWith('bluez_')
  )
  return own?.description
    ? { label: own.description, why: 'this computer’s, so the earbuds need not switch to headset mode' }
    : { label: null, why: 'the earbuds’ (the computer has no microphone of its own)' }
}

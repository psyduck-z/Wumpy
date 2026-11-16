import { execFile } from 'node:child_process'
import { earbudsMic, type MicState } from '@shared/btmic'

/**
 * Whether the earbuds' own microphone is running yet, on Linux.
 *
 * The system's default microphone, with Bluetooth earbuds connected, is a
 * stand-in that WirePlumber puts there: opening it is what makes the
 * earbuds switch to headset mode, and until they have, it delivers a faint
 * hiss rather than nothing. The recorder took that hiss for a working mic
 * and said "talk now" up to five seconds before anything could be heard.
 * PipeWire knows better: the earbuds' real mic appears as its own source
 * once they have switched, and is RUNNING while it delivers.
 *
 * 'none' when the default mic is not Bluetooth, on another system, or when
 * pactl is not there to ask - the recorder then goes by the sound alone,
 * as it always did.
 */
let defaultSource: { name: string; at: number } | null = null

function pactl(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 1500 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

export async function micState(): Promise<MicState> {
  if (process.platform !== 'linux') return 'none'
  /* The default changes rarely; asked again every few seconds, not on every
     poll, so a poll is one pactl call. */
  if (!defaultSource || Date.now() - defaultSource.at > 5000) {
    defaultSource = { name: (await pactl(['get-default-source'])).trim(), at: Date.now() }
  }
  if (!defaultSource.name.startsWith('bluez_input.')) return 'none'
  return earbudsMic(defaultSource.name, await pactl(['list', 'sources', 'short']))
}

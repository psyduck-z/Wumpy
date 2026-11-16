import { execFile } from 'node:child_process'
import { earbudsMic, musicMode, nodeState, realMicName, type MicState } from '@shared/btmic'

/**
 * Whether the earbuds' own microphone is running yet, on Linux.
 *
 * The system's default microphone, with Bluetooth earbuds connected, is a
 * stand-in that WirePlumber puts there: opening it is what makes the
 * earbuds switch to headset mode, and until they have, it delivers a faint
 * hiss rather than nothing. The recorder took that hiss for a working mic
 * and said "talk now" up to five seconds before anything could be heard.
 * PipeWire knows better: the earbuds' real mic appears as a node of its own
 * once they have switched, and is running while it delivers.
 *
 * Asked with `pw-dump <name>` (about 14ms), since that mic is internal and
 * `pactl` does not list it; with `pactl` where there is no pw-dump.
 *
 * 'none' when the default mic is not Bluetooth, on another system, or when
 * there is nothing to ask - the recorder then goes by the sound alone, as it
 * always did.
 */
let defaultSource: { name: string; real: string; at: number } | null = null

/** A command's output; null if it could not be run at all. */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve(null)
      else resolve(err ? '' : String(stdout))
    })
  })
}

/**
 * The earbuds' mic, and whether sound is going to the earbuds right now:
 * while they switch modes their output is gone for a moment and the system
 * plays everything from the laptop's speakers instead, so the ticks that
 * fill that wait hold off (null where there is nothing to ask).
 */
export async function micState(): Promise<{ mic: MicState; earbudsOut: boolean | null }> {
  const mic = await earbudsMicState()
  if (mic === 'none') return { mic, earbudsOut: null }
  const sink = ((await run('pactl', ['get-default-sink'])) ?? '').trim()
  return { mic, earbudsOut: sink ? sink.startsWith('bluez_output.') : null }
}

async function earbudsMicState(): Promise<MicState> {
  if (process.platform !== 'linux') return 'none'
  /* The default changes rarely; asked again every few seconds, not on every
     poll, so a poll is one quick call. */
  if (!defaultSource || Date.now() - defaultSource.at > 5000) {
    const name = ((await run('pactl', ['get-default-source'])) ?? '').trim()
    let target: string | undefined
    if (name.startsWith('bluez_input.') && name.includes(':')) {
      const stand = await run('pw-dump', [`bluez_capture_internal.${name.slice('bluez_input.'.length)}`])
      try {
        target = JSON.parse(stand || '[]')?.[0]?.info?.props?.['target.object']
      } catch {
        target = undefined
      }
    }
    defaultSource = { name, real: realMicName(name, target), at: Date.now() }
  }
  if (!defaultSource.name.startsWith('bluez_input.')) return 'none'
  const dump = await run('pw-dump', [defaultSource.real])
  if (dump !== null) return nodeState(dump, defaultSource.real)
  return earbudsMic(defaultSource.name, (await run('pactl', ['list', 'sources', 'short'])) ?? '')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Waits, before music is resumed, for earbuds to be back in their music
 * mode. Closing the mic only starts that: WirePlumber switches them back
 * about two seconds later, and the switch itself takes another moment, in
 * which their output is gone. Asked of PipeWire every quarter second until
 * it has said so twice running, then a beat for it to move the music back
 * to them; never more than `maxMs`. On Windows, which switches them itself
 * and says nothing, a fixed moment instead.
 */
export async function backToMusicMode(maxMs = 8000): Promise<string> {
  if (process.platform === 'win32') {
    await sleep(1500)
    return 'waited 1.5s'
  }
  if (process.platform !== 'linux') return 'nothing to wait for'
  const started = Date.now()
  let ready = 0
  let seen = 'ready'
  while (Date.now() - started < maxMs) {
    const dump = await run('pw-dump', [])
    if (dump === null) return 'no pw-dump to ask'
    const mode = musicMode(dump)
    if (mode !== 'ready') seen = mode
    ready = mode === 'ready' ? ready + 1 : 0
    if (ready >= 2) {
      if (seen === 'ready' && Date.now() - started < 600) return 'already in music mode'
      await sleep(400)
      return `back in music mode after ${Date.now() - started}ms`
    }
    await sleep(250)
  }
  return `still not in music mode after ${maxMs}ms`
}

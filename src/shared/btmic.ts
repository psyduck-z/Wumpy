/**
 * The earbuds' microphone, read from `pactl list sources short`.
 *
 * Pure, so it can be checked without earbuds (scripts/check-voicebar.mjs).
 * See main/btmic.ts for why it is asked at all.
 */
export type MicState = 'none' | 'switching' | 'running'

/**
 * `defaultName` is the default source, a Bluetooth one. WirePlumber's
 * stand-in is named with the address in colons (bluez_input.2C:BE:...);
 * the earbuds' real mic, which exists only in headset mode, with
 * underscores and a number (bluez_input.2C_BE_..._CC.0). Without the
 * stand-in, the default is the real one itself. Either way: running when a
 * real one is RUNNING, switching otherwise.
 */
export function earbudsMic(defaultName: string, sources: string): MicState {
  const id = defaultName.slice('bluez_input.'.length).split('.')[0].replace(/:/g, '_')
  if (!id) return 'none'
  for (const line of sources.split('\n')) {
    const [, name, , , state] = line.split('\t')
    if (!name || !name.startsWith(`bluez_input.${id}`) || name.includes(':')) continue
    if ((state ?? '').trim() === 'RUNNING') return 'running'
  }
  return 'switching'
}

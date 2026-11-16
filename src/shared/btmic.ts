/**
 * The earbuds' microphone, read from `pactl list sources short`.
 *
 * Pure, so it can be checked without earbuds (scripts/check-voicebar.mjs).
 * See main/btmic.ts for why it is asked at all.
 */
/**
 * 'absent': the earbuds' own mic is not listed at all (yet - it appears only
 * once they are in headset mode); 'switching': listed, not running yet.
 */
export type MicState = 'none' | 'absent' | 'switching' | 'running'

/**
 * `defaultName` is the default source, a Bluetooth one. WirePlumber's
 * stand-in is named with the address in colons (bluez_input.2C:BE:...);
 * the earbuds' real mic, which exists only in headset mode, with
 * underscores and a number (bluez_input.2C_BE_..._CC.0). Without the
 * stand-in, the default is the real one itself. Either way: running when a
 * real one is RUNNING, switching when it is there but not running, absent
 * when it is not there.
 */
export function earbudsMic(defaultName: string, sources: string): MicState {
  const id = defaultName.slice('bluez_input.'.length).split('.')[0].replace(/:/g, '_')
  if (!id) return 'none'
  let listed = false
  for (const line of sources.split('\n')) {
    const [, name, , , state] = line.split('\t')
    if (!name || !name.startsWith(`bluez_input.${id}`) || name.includes(':')) continue
    listed = true
    if ((state ?? '').trim() === 'RUNNING') return 'running'
  }
  return listed ? 'switching' : 'absent'
}

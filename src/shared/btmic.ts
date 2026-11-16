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

/**
 * The same from PipeWire itself: `pw-dump <name>` for the earbuds' own mic.
 * On Omarchy (WirePlumber 0.5) that mic is internal, behind the stand-in,
 * and `pactl` never lists it - logged: "PipeWire never listed the earbuds'
 * own mic" while PipeWire's own log showed it running. Absent when the dump
 * is empty or has no node of that name.
 */
export function nodeState(dump: string, name: string): MicState {
  let objects: unknown
  try {
    objects = JSON.parse(dump.trim() || '[]')
  } catch {
    return 'absent'
  }
  if (!Array.isArray(objects)) return 'absent'
  const node = objects.find(
    (o) => o?.type === 'PipeWire:Interface:Node' && o?.info?.props?.['node.name'] === name
  ) as { info: { state?: string } } | undefined
  if (!node) return 'absent'
  return node.info.state === 'running' ? 'running' : 'switching'
}

/**
 * The earbuds' own mic's node name, for a Bluetooth default source: the
 * stand-in's target when it says, else the usual name for its address -
 * or the default itself, when it is the real mic.
 */
export function realMicName(defaultName: string, target?: string): string {
  if (!defaultName.includes(':')) return defaultName
  if (target?.startsWith('bluez_input.')) return target
  return `bluez_input.${defaultName.slice('bluez_input.'.length).replace(/:/g, '_')}.0`
}

/**
 * Whether Bluetooth earbuds are back in their music mode, from a whole
 * `pw-dump`: 'headset' while their own mic is there (headset mode, mono,
 * phone quality), 'switching' while there is no music output for them yet,
 * 'ready' once there is - or when there are no earbuds at all.
 *
 * Music resumed any sooner played in headset mode, "blurry, no spatial
 * sound", and when the earbuds then switched back their output went away
 * for a moment and it played from the laptop's speakers instead.
 */
export function musicMode(dump: string): 'ready' | 'headset' | 'switching' {
  let objects: unknown
  try {
    objects = JSON.parse(dump.trim() || '[]')
  } catch {
    return 'ready'
  }
  if (!Array.isArray(objects)) return 'ready'
  let bluetooth = false
  let music = false
  for (const o of objects) {
    if (o?.type !== 'PipeWire:Interface:Node') continue
    const props = o?.info?.props ?? {}
    const name = String(props['node.name'] ?? '')
    const profile = String(props['api.bluez5.profile'] ?? '')
    if (!name.startsWith('bluez_input.') && !name.startsWith('bluez_output.')) continue
    /* The earbuds' own mic: real, not the stand-in (whose name has colons). */
    if (name.startsWith('bluez_input.') && !name.includes(':')) return 'headset'
    if (/headset|hfp|hsp/i.test(profile)) return 'headset'
    if (name.startsWith('bluez_output.')) {
      bluetooth = true
      if (/a2dp/i.test(profile) && o?.info?.state !== 'error') music = true
    }
    if (name.startsWith('bluez_input.')) bluetooth = true
  }
  return !bluetooth || music ? 'ready' : 'switching'
}

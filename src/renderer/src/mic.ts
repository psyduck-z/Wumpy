/**
 * The microphone to open, as the page names it. The decision is the main
 * process's (main/mic.ts, which can ask the audio system whether the
 * default is a Bluetooth headset's); this turns its label into a device.
 */
export interface ChosenMic {
  /** For getUserMedia; absent means the system default. */
  deviceId?: string
  /** What was opened, for the log and /microphone. */
  label: string
  why: string
}

/** Chromium's stand-ins for "whatever the system says", not real devices. */
const VIRTUAL = new Set(['default', 'communications'])

async function inputs(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}

export async function chosenMic(): Promise<ChosenMic> {
  const plan = await window.wumpy.voice.micPlan().catch(() => ({ label: null, why: 'the system default' }))
  if (!plan.label) return { label: 'the system default', why: plan.why }
  const all = await inputs()
  const match = all.find((d) => d.label === plan.label) ?? all.find((d) => d.label.includes(plan.label!))
  return match
    ? { deviceId: match.deviceId, label: match.label, why: plan.why }
    : { label: 'the system default', why: `“${plan.label}” is not connected` }
}

/** The real microphones, by label, in the order /microphone numbers them. */
export async function microphones(): Promise<string[]> {
  return (await inputs()).filter((d) => !VIRTUAL.has(d.deviceId) && d.label).map((d) => d.label)
}

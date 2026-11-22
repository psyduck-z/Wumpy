import type { VoiceprintState } from '@shared/types'

/** What /voice me says: how far the voiceprint has got, and what it does. */
export function voiceprintNote(print: VoiceprintState, change: 'status' | 'on' | 'off' | 'forget' | 'calibrate'): string {
  const how =
    '`/voice me calibrate` reads a few sentences to learn it on purpose; `/voice me off` answers anyone again; ' +
    '`/voice me forget` starts over.'
  if (!print.on)
    return (
      'Only your voice: **off** — conversations answer whoever talks, and nothing is learned. ' +
      `\`/voice me on\` turns it back on${print.known ? ', with your voice as it was learned' : ''}.`
    )
  const forgot = change === 'forget' ? 'Forgotten. ' : ''
  if (!print.known)
    return (
      `${forgot}Learning your voice: **${print.clips} of ${print.needed}** so far. It learns from what you say in ` +
      'conversations (hold an earbud), on this PC only; once it has enough, other voices are not answered. ' +
      'Quicker and surer: `/voice me calibrate`, and read a few sentences. ' +
      how
    )
  if (change === 'calibrate')
    return (
      `Calibrated${print.calibratedOn ? ` on **${print.calibratedOn}**` : ''}: Wumpy knows your voice. In conversations, ` +
      'other voices are not answered, and a spoken "yes" to run something has to be yours. It keeps learning as you ' +
      'talk, always anchored to the sentences you just read. ' +
      how
    )
  const mics = print.devices.length ? ` (heard on ${print.devices.map((d) => `**${d}**`).join(', ')})` : ''
  return (
    `Only your voice: **on**. Wumpy knows your voice${print.calibrated ? ' (calibrated)' : ' (learned, not calibrated)'}` +
    `${mics} and keeps learning it as you talk; in conversations, someone else talking is not answered, and ` +
    'someone else talking over an answer only pauses it a moment. ' +
    how
  )
}

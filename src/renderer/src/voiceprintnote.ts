import type { VoiceprintState } from '@shared/types'

/** What /voice me says: how far the voiceprint has got, and what it does. */
export function voiceprintNote(print: VoiceprintState, change: 'status' | 'on' | 'off' | 'forget'): string {
  const how = '`/voice me off` answers anyone again; `/voice me forget` starts learning your voice over.'
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
      how
    )
  const mics = print.devices.length ? ` (heard on ${print.devices.map((d) => `**${d}**`).join(', ')})` : ''
  return (
    'Only your voice: **on**. Wumpy knows your voice' +
    `${mics} and keeps learning it as you talk; in conversations, someone else talking is not answered, and ` +
    'someone else talking over an answer only pauses it a moment. ' +
    how
  )
}

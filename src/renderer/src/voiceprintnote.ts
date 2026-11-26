import type { VoiceprintState } from '@shared/types'

/**
 * What /voice me says: how far the voiceprint has got. One line each -
 * "shorten it, like really short"; `/help` has the subcommands.
 */
export function voiceprintNote(print: VoiceprintState, change: 'status' | 'on' | 'off' | 'forget' | 'calibrate'): string {
  if (!print.on) return 'Only your voice: **off**. `/voice me on` turns it back on.'
  const forgot = change === 'forget' ? 'Forgotten. ' : ''
  if (!print.known)
    return `${forgot}Learning your voice: **${print.clips} of ${print.needed}**. \`/voice me calibrate\` is quicker.`
  if (change === 'calibrate')
    return `Calibrated${print.calibratedOn ? ` on **${print.calibratedOn}**` : ''}: only your voice is answered now.`
  return `Only your voice: **on**${print.calibrated ? ' (calibrated)' : ''}. \`/voice me calibrate\` · \`off\` · \`forget\``
}

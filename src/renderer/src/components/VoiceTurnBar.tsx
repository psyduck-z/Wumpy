import { FINISHED, stopVoice, useVoiceView, type VoiceStage } from '../voiceview'

const STAGE: Record<Exclude<VoiceStage, 'idle'>, string> = {
  starting: 'Voice',
  listening: 'Listening',
  hearing: 'Hearing',
  thinking: 'Thinking',
  speaking: 'Speaking',
  done: 'Finished',
  nothing: 'Heard nothing',
  cancelled: 'Ending',
  error: 'Voice problem'
}

/**
 * A voice turn, on screen: what stage it is at, the mic level while it
 * listens, what it heard, and Stop. See voiceview.ts for why it exists.
 */
export function VoiceTurnBar(): React.JSX.Element | null {
  const v = useVoiceView()
  if (v.stage === 'idle') return null

  const text =
    v.stage === 'starting'
      ? v.detail || 'Opening the microphone…'
      : v.stage === 'listening'
        ? v.detail || 'Say something.'
        : v.stage === 'hearing'
          ? 'Working out what you said…'
          : v.stage === 'thinking'
            ? v.heard
              ? `“${v.heard}”`
              : 'Working on it…'
            : v.stage === 'speaking'
              ? v.detail
              : v.detail || (v.heard ? `“${v.heard}”` : '')

  return (
    <div className={`voice-turn is-${v.stage}`} role="status" aria-live="polite">
      <span className="voice-turn-stage">{STAGE[v.stage]}</span>
      {v.stage === 'listening' && (
        <span className="voice-turn-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.04, v.level)})` }} />
        </span>
      )}
      <span className="voice-turn-text" title={text}>
        {text}
      </span>
      {!FINISHED.has(v.stage) && (
        <button type="button" className="voice-turn-stop" onClick={stopVoice}>
          End
        </button>
      )}
    </div>
  )
}

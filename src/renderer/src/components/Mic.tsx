import type { Dictation } from '../hooks/useDictation'

/**
 * The microphone button, and what it says while it is listening.
 *
 * It reports what is happening in words as well as colour: "Listening" with a
 * level that moves is the only way to tell a microphone that is working from one
 * Windows has muted, and a dead meter is a much clearer symptom than silence.
 */
export function Mic({ dictation }: { dictation: Dictation }): React.JSX.Element | null {
  const { state, level, detail, heard, polished } = dictation

  // Nothing is shown when there is nothing to offer, except the reason, once, on
  // hover - a button that only ever produces an error is worse than no button.
  if (state === 'unavailable') {
    return detail ? (
      <button
        type="button"
        className="mic mic-off"
        title={`Dictation unavailable. ${detail}`}
        disabled
      >
        <MicGlyph muted />
      </button>
    ) : null
  }

  const label =
    state === 'recording'
      ? 'Listening - let go of the spacebar to finish, Esc to discard'
      : state === 'working'
        ? 'Transcribing'
        : state === 'loading'
          ? 'Loading the speech model'
          : 'Talk - hold the spacebar, or Ctrl+M'

  return (
    <>
      <button
        type="button"
        className={`mic mic-${state}`}
        onClick={dictation.toggle}
        title={label}
        aria-label={label}
        aria-pressed={state === 'recording'}
      >
        <MicGlyph />
        {state === 'recording' && (
          // Scaled from the live input level, so you can see it hearing you.
          <span className="mic-level" style={{ transform: `scaleY(${0.25 + level * 0.75})` }} />
        )}
      </button>

      {(state === 'recording' || state === 'working' || state === 'loading' || detail) && (
        <div className={`mic-status${detail && state !== 'recording' ? ' mic-status-note' : ''}`}>
          {state === 'recording' && <>Listening… let go to send</>}
          {state === 'working' && <>Transcribing…</>}
          {state === 'loading' && <>Loading the speech model…</>}
          {state !== 'recording' && state !== 'working' && state !== 'loading' && detail && (
            <button
              type="button"
              className="mic-dismiss"
              onClick={dictation.dismiss}
              title="Dismiss"
            >
              {detail}
            </button>
          )}
          {/*
            What was actually heard, when the correction pass changed it. The
            transcript the user can check is the difference between a tool they
            can trust and one they have to.
          */}
          {heard && polished && state === 'idle' && !detail && (
            <span className="mic-heard" title={`Heard: ${heard}`}>
              tidied
            </span>
          )}
        </div>
      )}
    </>
  )
}

function MicGlyph({ muted = false }: { muted?: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 1.75a2.25 2.25 0 0 0-2.25 2.25v3.5a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75Z"
        fill="currentColor"
      />
      <path
        d="M3.75 7a.75.75 0 0 1 1.5 0 2.75 2.75 0 0 0 5.5 0 .75.75 0 0 1 1.5 0 4.25 4.25 0 0 1-3.5 4.18V13h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.82A4.25 4.25 0 0 1 3.75 7Z"
        fill="currentColor"
      />
      {muted && (
        <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  )
}

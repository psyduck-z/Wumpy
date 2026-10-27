/**
 * Hearing the machine, not just the microphone.
 *
 * Asked for as meeting notes: "allow the AI to listen to computer audio...
 * during meetings, it's able to get the summary, notes, specific details".
 * The microphone already in this app hears the room, which in a headset call
 * is exactly one of the voices - the half the user did not need written down.
 *
 * What makes the other half reachable is WASAPI loopback: the mix Windows is
 * already sending to the output device, tapped without a virtual cable, a
 * driver or anything to install. Electron exposes it through the display-media
 * handler in src/main/panel.ts, which answers the request with
 * `audio: 'loopback'`.
 *
 * NO PICTURE IS EVER TAKEN. `getDisplayMedia` is a video API and refuses a
 * request with no video in it, so a screen source has to be named - and the
 * first thing done with the stream here is to stop that track, before a frame
 * can be decoded. Nothing in this file reads pixels. The screen has its own
 * route, its own setting and its own consent; this is not a second one.
 */

/** Where the sound comes from. */
export type AudioSource =
  /** The microphone, as dictation has always used. */
  | 'mic'
  /** What the speakers are playing: the other people in the call. */
  | 'system'
  /** Both, mixed - which is what notes of a conversation actually need. */
  | 'both'

/** The mic constraints dictation settled on, reused so both paths match. */
const MIC: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

/** An open tap: the stream to record, what it is made of, and how to close it. */
export interface Listening {
  stream: MediaStream
  /** What was actually opened, for the log. Device names, never audio. */
  sources: string[]
  stop(): void
}

/** Audio track names, which is as much as the browser will say about a device. */
function labels(stream: MediaStream): string[] {
  return stream.getAudioTracks().map((t) => t.label || t.kind)
}

function stopAll(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop())
}

export function canHearSystem(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia)
}

/**
 * The loopback stream, with the video thrown away immediately.
 *
 * Throws with something a person can act on. The failures here are not the
 * microphone's: there is no Windows privacy toggle for loopback and no
 * per-app permission, so a refusal is almost always the handler in main not
 * being registered or no display being found.
 */
async function systemAudio(): Promise<MediaStream> {
  if (!canHearSystem()) throw new Error('This build cannot capture system audio.')
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  })
  /* Before anything can decode a frame. The track is stopped and removed, so
     the stream that leaves this function has no video in it at all. */
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error(
      'Windows shared the screen but no sound. Something has to be playing for ' +
        'loopback to have anything to capture.'
    )
  }
  return stream
}

/**
 * One stream carrying whichever sources were asked for.
 *
 * Mixed in a Web Audio graph rather than handed over as two tracks, because
 * everything downstream - the level meter, the pause detector, MediaRecorder,
 * and Whisper itself - takes one mono input. Two tracks would mean two
 * recorders, two transcripts and the job of interleaving them by timestamp,
 * which is a diarisation problem rather than a recording one.
 *
 * The cost of mixing is that the transcript does not say who spoke. That is
 * the honest trade and it is worth stating: these are notes of a conversation,
 * not minutes with attributions.
 */
export async function listenTo(source: AudioSource): Promise<Listening> {
  if (source === 'mic') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: MIC })
    return { stream: mic, sources: labels(mic), stop: () => stopAll(mic) }
  }

  if (source === 'system') {
    const sys = await systemAudio()
    return { stream: sys, sources: labels(sys), stop: () => stopAll(sys) }
  }

  /*
   * Both. The system half comes first on purpose: it is the one that can
   * fail, and failing before the microphone is opened means no recording
   * light comes on for a capture that was never going to happen.
   */
  const sys = await systemAudio()
  let mic: MediaStream
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: MIC })
  } catch (err) {
    sys.getTracks().forEach((t) => t.stop())
    throw err
  }

  const ctx = new AudioContext()
  const mixed = ctx.createMediaStreamDestination()

  /*
   * Limited at the top, not halved throughout - and the difference was a
   * whole meeting transcribed as silence.
   *
   * Two full-scale sources summed into one channel clip, and clipping is the
   * one distortion Whisper handles badly: it is trained on ordinary
   * recordings and a square wave is not one. The first answer to that was a
   * gain of 0.5 on each, so the sum could not exceed full scale however loud
   * both got at once. Arithmetically sound, and it taxed every quiet moment
   * to pay for a loud one that mostly never comes - in a call the mic's echo
   * canceller has already removed the far end from it, so the two sources
   * are one voice each and rarely both at full scale.
   *
   * What it cost is downstream. The recorder's speech gate is an ABSOLUTE
   * RMS threshold (SPEECH_LEVEL, 0.02) calibrated on an un-halved
   * microphone, and nothing told it the signal had been turned down 6dB. So
   * in `both` - the default - the gate effectively sat at 0.04 on the
   * source, which is the middle of the 0.02-0.10 band its own comment calls
   * ordinary speech. Below it nothing is ever cut, nothing reaches Whisper,
   * and the transcript stays empty: a session that hears a conversation
   * perfectly well and reports that it heard nothing but silence.
   *
   * A limiter puts the cost where the problem is. Normal speech passes at
   * unity, so `both` now reaches the gate at the same level `mic` always
   * did; only the top 3dB is touched, and only while both are loud at once.
   * There is no makeup gain in this node, so nothing quiet is lifted either
   * - the room stays as quiet as it was, which is what keeps the gate
   * meaningful.
   */
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 0
  limiter.ratio.value = 20
  /* 3ms rather than 0: a true brick wall distorts low frequencies audibly,
     and letting a rare 3ms transient through is cheaper than that. */
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
  limiter.connect(mixed)

  for (const stream of [sys, mic]) {
    ctx.createMediaStreamSource(stream).connect(limiter)
  }

  return {
    stream: mixed.stream,
    /* The INPUTS, not the mixed output, whose track is called "MediaStream
       Audio Destination Node" and says nothing. These name the real devices,
       which is how a session listening to the wrong microphone - or to a
       default output the meeting is not playing to - becomes a line in the
       log rather than an hour of unexplained silence. */
    sources: [...labels(sys), ...labels(mic)],
    stop: () => {
      stopAll(sys)
      stopAll(mic)
      /* The graph holds the audio device open until it is closed, which on
         Windows shows as a microphone-in-use indicator long after the
         recording ended. */
      void ctx.close().catch(() => {})
    }
  }
}

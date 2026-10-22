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
export async function listenTo(
  source: AudioSource
): Promise<{ stream: MediaStream; stop(): void }> {
  if (source === 'mic') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: MIC })
    return { stream: mic, stop: () => mic.getTracks().forEach((t) => t.stop()) }
  }

  if (source === 'system') {
    const sys = await systemAudio()
    return { stream: sys, stop: () => sys.getTracks().forEach((t) => t.stop()) }
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
   * Halved, both of them.
   *
   * Two full-scale sources summed into one channel clip at the top, and
   * clipping is the one distortion Whisper handles badly - it is trained on
   * ordinary recordings, and a square wave is not one. Half each means the
   * sum cannot exceed full scale however loud both get at once. It costs
   * 6dB, which the transcriber's own normalisation takes straight back.
   */
  for (const stream of [sys, mic]) {
    const gain = ctx.createGain()
    gain.gain.value = 0.5
    ctx.createMediaStreamSource(stream).connect(gain).connect(mixed)
  }

  return {
    stream: mixed.stream,
    stop: () => {
      sys.getTracks().forEach((t) => t.stop())
      mic.getTracks().forEach((t) => t.stop())
      /* The graph holds the audio device open until it is closed, which on
         Windows shows as a microphone-in-use indicator long after the
         recording ended. */
      void ctx.close().catch(() => {})
    }
  }
}

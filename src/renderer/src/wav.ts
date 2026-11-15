/**
 * Recorded clips as 16 kHz mono 16-bit WAV, the shape speech models want.
 *
 * MediaRecorder hands back WebM/Opus, which Whisper can open but NVIDIA's
 * recognisers cannot: they take raw PCM. Chromium can decode its own
 * recording, and an OfflineAudioContext resamples and folds it to mono in
 * one pass - the same code on Windows and Linux, with no ffmpeg to find.
 * Whisper reads the WAV just as happily, so every clip goes this way.
 */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(out)
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/**
 * A quiet clip brought up to a normal level, in place.
 *
 * A laptop's own microphone can deliver speech at a hundredth of full
 * scale (see recorder.ts, MIN_SPEECH_LEVEL), and a transcriber does better
 * with a voice at the level it was trained on. Scaled so the loudest
 * sample is at 0.9, by at most 30 dB, and never made quieter.
 */
export function louder(samples: Float32Array): Float32Array {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  if (peak <= 1e-4 || peak >= 0.5) return samples
  const gain = Math.min(0.9 / peak, 31.6)
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
  return samples
}

/**
 * A clip ready for transcription. Falls back to the clip as recorded if it
 * will not decode, so a strange container costs accuracy at worst, not the
 * dictation.
 */
export async function clipForSpeech(
  blob: Blob,
  extension: string
): Promise<{ audio: ArrayBuffer; extension: string }> {
  const raw = await blob.arrayBuffer()
  try {
    const context = new AudioContext()
    let decoded: AudioBuffer
    try {
      decoded = await context.decodeAudioData(raw.slice(0))
    } finally {
      void context.close()
    }
    const rate = 16000
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return { audio: encodeWav(louder(rendered.getChannelData(0)), rate), extension: 'wav' }
  } catch {
    return { audio: raw, extension }
  }
}

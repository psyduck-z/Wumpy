/**
 * Speech on NVIDIA's hosted models: Parakeet to hear, Magpie to talk.
 *
 * Why hosted, when Wumpy is local first: on the laptops this runs on, Whisper
 * base.en on the CPU is the most that keeps up, and it is the weakest part of
 * dictation. Parakeet is far more accurate and answers in a fraction of a
 * second, and Magpie is a natural voice where the local options are robotic
 * or slow. Both run on the same NVIDIA keys as chat, from the same rotation,
 * so they cost nothing extra and fall inside the same per-minute allowance.
 * Whisper stays as the fallback when there is no key or no network.
 *
 * NVIDIA serves both over Riva's gRPC protocol at grpc.nvcf.nvidia.com: the
 * model is chosen by a `function-id` header and the key goes in as a bearer
 * token. The .proto files are NVIDIA's own (resources/riva, MIT licensed), and
 * @grpc/grpc-js is pure JavaScript, so this is identical on Windows and Linux.
 */
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { resourcePath } from './tray'

const HOST = 'grpc.nvcf.nvidia.com:443'

/**
 * The hosted models, by their function ids on build.nvidia.com. Kept
 * overridable from the environment because NVIDIA does move these, and a
 * moved id should not need a release to fix.
 */
export const SPEECH_MODELS = {
  /** parakeet-tdt-0.6b-v2: English, punctuated, offline recognition. */
  hear: process.env.WUMPY_NV_ASR_FUNCTION ?? 'd3fe9151-442b-4204-a70d-5fcc597fd610',
  /** magpie-tts-multilingual. */
  talk: process.env.WUMPY_NV_TTS_FUNCTION ?? '877104f7-e885-42b9-8de8-f6e4c6303969'
}

export const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Aria'
const TTS_RATE = 22050

/** One key, borrowed from the rotation for one call. */
export interface BorrowedKey {
  key: string
  done(status: number): void
}

type Loaded = {
  asr: grpc.ServiceClientConstructor
  tts: grpc.ServiceClientConstructor
}

let loaded: Loaded | null = null

function load(): Loaded {
  if (loaded) return loaded
  const root = resourcePath('riva')
  const definition = protoLoader.loadSync(['riva/proto/riva_asr.proto', 'riva/proto/riva_tts.proto'], {
    includeDirs: [root],
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = grpc.loadPackageDefinition(definition) as any
  const riva = pkg.nvidia.riva
  loaded = { asr: riva.asr.RivaSpeechRecognition, tts: riva.tts.RivaSpeechSynthesis }
  return loaded
}

/** gRPC status, in the HTTP terms the key rotation already understands. */
function httpStatus(code: number | undefined): number {
  switch (code) {
    case grpc.status.UNAUTHENTICATED:
      return 401
    case grpc.status.PERMISSION_DENIED:
      return 403
    case grpc.status.RESOURCE_EXHAUSTED:
      return 429
    case grpc.status.OK:
      return 200
    default:
      return 500
  }
}

function call<Req, Res>(
  Client: grpc.ServiceClientConstructor,
  method: string,
  request: Req,
  borrowed: BorrowedKey,
  functionId: string,
  timeoutMs: number
): Promise<Res> {
  const client = new Client(HOST, grpc.credentials.createSsl())
  const metadata = new grpc.Metadata()
  metadata.set('function-id', functionId)
  metadata.set('authorization', `Bearer ${borrowed.key}`)
  return new Promise<Res>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(client as any)[method](
      request,
      metadata,
      { deadline: Date.now() + timeoutMs },
      (err: grpc.ServiceError | null, response: Res) => {
        client.close()
        borrowed.done(httpStatus(err?.code ?? grpc.status.OK))
        if (err) reject(new Error(`NVIDIA ${method}: ${err.details || err.message}`))
        else resolve(response)
      }
    )
  })
}

/** A WAV file around 16-bit mono PCM, for players that want a container. */
export function wavFrom(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * The samples of a 16-bit PCM WAV, and its rate. The renderer sends every
 * clip as one (see renderer/src/wav.ts), so this only has to read that shape.
 */
export function pcmFromWav(wav: Uint8Array): { pcm: Buffer; sampleRate: number } | null {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let sampleRate = 16000
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4)
    const size = b.readUInt32LE(offset + 4)
    if (id === 'fmt ') sampleRate = b.readUInt32LE(offset + 12)
    if (id === 'data') return { pcm: b.subarray(offset + 8, Math.min(b.length, offset + 8 + size)), sampleRate }
    offset += 8 + size + (size % 2)
  }
  return null
}

/**
 * What Parakeet heard. `confidence` is the model's own, 0..1, so it can stand
 * where Whisper's did.
 */
export async function recognize(
  wav: Uint8Array,
  borrowed: BorrowedKey
): Promise<{ text: string; confidence: number; ms: number; audioSeconds: number }> {
  const audio = pcmFromWav(wav)
  if (!audio) throw new Error('recognition needs a 16-bit PCM WAV clip')
  const started = Date.now()
  const response = await call<unknown, { results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }>; audio_processed?: number }> }>(
    load().asr,
    'Recognize',
    {
      config: {
        encoding: 'LINEAR_PCM',
        sample_rate_hertz: audio.sampleRate,
        language_code: 'en-US',
        max_alternatives: 1,
        enable_automatic_punctuation: true,
        audio_channel_count: 1
      },
      audio: audio.pcm
    },
    borrowed,
    SPEECH_MODELS.hear,
    30_000
  )
  const parts = (response.results ?? []).map((r) => r.alternatives?.[0]).filter(Boolean)
  const text = parts.map((a) => a?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim()
  const confidence = parts.length
    ? parts.reduce((n, a) => n + (a?.confidence ?? 0), 0) / parts.length
    : 0
  return {
    text,
    // Parakeet reports 0 when it does not score; treat that as "fine", since
    // an empty transcript is how it says it heard nothing.
    confidence: confidence > 0 ? Math.min(1, confidence) : text ? 0.9 : 0,
    ms: Date.now() - started,
    audioSeconds: audio.pcm.length / 2 / audio.sampleRate
  }
}

/** Magpie's voice for `text`, as a WAV file. */
export async function synthesize(
  text: string,
  borrowed: BorrowedKey,
  voice = DEFAULT_VOICE
): Promise<{ wav: Buffer; ms: number }> {
  const started = Date.now()
  const response = await call<unknown, { audio?: Buffer }>(
    load().tts,
    'Synthesize',
    {
      text,
      language_code: 'en-US',
      encoding: 'LINEAR_PCM',
      sample_rate_hz: TTS_RATE,
      voice_name: voice
    },
    borrowed,
    SPEECH_MODELS.talk,
    30_000
  )
  const pcm = response.audio ?? Buffer.alloc(0)
  if (pcm.length === 0) throw new Error('NVIDIA Synthesize returned no audio')
  return { wav: wavFrom(Buffer.from(pcm), TTS_RATE), ms: Date.now() - started }
}

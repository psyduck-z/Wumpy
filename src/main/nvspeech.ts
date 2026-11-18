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
import { forMagpie } from '@shared/voicetext'

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

/**
 * Recognisers to compare Parakeet with, on the same keys: "the speech to
 * text model is kind of idiotic" - "how much RAM does this PC have" came
 * back as "...does a specie have". `wumpy --hearing-check` runs each on the
 * same sentences, and `wumpy --compare-hearing` on what is really said, so
 * the choice is made on numbers. The ids are build.nvidia.com's, which can
 * move; one that fails says so in the log and is left out.
 *
 * `boost` asks for BOOSTED_WORDS to be favoured, at that score: 20-100 for
 * CTC models, 0.5-2 for TDT and RNNT ones, as NVIDIA advises.
 */
export interface Hearer {
  name: string
  functionId: string
  language: string
  boost?: number
  /** Heard alongside HEARING in `--compare-hearing`: the strongest only, as each costs a request. */
  compare?: boolean
}
export const HEARERS: Hearer[] = [
  { name: 'parakeet-tdt-0.6b', functionId: SPEECH_MODELS.hear, language: 'en-US', compare: true },
  { name: 'parakeet-tdt-0.6b+words', functionId: SPEECH_MODELS.hear, language: 'en-US', boost: 1.5 },
  { name: 'parakeet-ctc-1.1b', functionId: '1598d209-5e27-4d3c-8079-4751568b1081', language: 'en-US' },
  { name: 'parakeet-ctc-1.1b+words', functionId: '1598d209-5e27-4d3c-8079-4751568b1081', language: 'en-US', boost: 40 },
  { name: 'parakeet-rnnt-1.1b', functionId: '71203149-d3b7-4460-8231-1be2543a1fca', language: 'en-US', compare: true },
  { name: 'canary-1b', functionId: 'b0e8b4a5-217c-40b7-9b96-17d84e666317', language: 'en-US', compare: true },
  { name: 'whisper-large-v3', functionId: process.env.WUMPY_NV_WHISPER_FUNCTION ?? 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d', language: 'en' }
]

/**
 * What hears a voice turn: Whisper large-v3, on NVIDIA, on the same keys.
 *
 * It was Parakeet TDT 0.6B v2, and "I need more accuracy, higher accuracy".
 * Our own sentences could not tell them apart - 1.7% each, read by Magpie -
 * but those are clean synthetic voices. On real people, Artificial Analysis's
 * word error rate (Nov 2026) has Parakeet TDT 0.6B v2 at 6.4% and Whisper
 * large-v3 at 4.1-4.5%: a third fewer words wrong. The more accurate ones
 * (Scribe, Voxtral, Gemini Transcribe) are paid, or free at a few requests a
 * minute, and this has to keep up with "the 40 requests per minute of the
 * NVIDIA API key" - each of the two. Whisper is the same allowance, so it
 * costs nothing that Parakeet did not, and is about 0.1s slower (554ms
 * against 445ms in `--hearing-check`).
 *
 * Parakeet stays as the fallback when Whisper fails, and as the check on
 * Whisper's one bad habit (see mayBeInvented).
 */
export const HEARING: Hearer = HEARERS.find((h) => h.name === 'whisper-large-v3')!
export const FALLBACK_HEARING: Hearer = HEARERS[0]

/**
 * Words a computer assistant hears that a general recogniser gets wrong,
 * in the cases NVIDIA asks for (it matches them as written).
 */
export const BOOSTED_WORDS = [
  'RAM', 'PC', 'GPU', 'CPU', 'SSD', 'USB', 'Wi-Fi', 'Bluetooth', 'gigabytes', 'terabyte', 'terabytes',
  'laptop', 'MacBook', 'ThinkPad', 'Lenovo', 'Windows', 'Linux', 'Arch', 'Omarchy', 'Hyprland', 'Waybar',
  'Wumpy', 'Nothing', 'earbuds', 'Chrome', 'Spotify', 'Discord', 'Steam', 'downloads', 'folder', 'terminal'
]

/*
 * Jason, neutral: chosen by ear, twice. From `wumpy --voice-samples`, Ray,
 * neutral - then, after a day of him, "I want to switch back to Jason
 * neutral, because I think Ray's intonation is kind of weird". Jason, Leo
 * and Ray are Magpie's American English men, each with moods (Diego and
 * Pascal speak English with a Spanish and a French accent); `wumpy
 * --speech-check` lists them all, asking the service rather than trusting
 * this.
 */
export const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Jason.Neutral'
/** The defaults before it, in order: a settings file naming one was never a choice. */
export const OLD_DEFAULT_VOICES = [
  'Magpie-Multilingual.EN-US.Aria',
  'Magpie-Multilingual.EN-US.Jason',
  'Magpie-Multilingual.EN-US.Ray.Neutral'
]
/** Answers' speed: "can you make Jason speak a little faster?" - again. */
export const DEFAULT_RATE = 1.25
export const OLD_DEFAULT_RATES = [1.15]
/** What the move to the voice above is remembered by, so it happens once. */
export const VOICE_CHOICE = 'jason-neutral-1.25'
const TTS_RATE = 22050

/**
 * Every voice model the keys might reach, for `wumpy --compare-voices`:
 * "what text to speech models does the free NVIDIA API key allow... and
 * compare them to my current one". Magpie Multilingual is the one in use.
 * Chatterbox is Resemble AI's, hosted by NVIDIA under the id its Nemotron
 * voice agent uses. Magpie Zeroshot and Flow clone a voice from a clip and
 * are only for accounts NVIDIA has let in; the check also asks NVIDIA which
 * functions the keys can see, and tries any voice model it names.
 */
export interface Talker {
  name: string
  functionId: string
}
export const TALKERS: Talker[] = [
  { name: 'magpie-tts-multilingual', functionId: SPEECH_MODELS.talk },
  { name: 'chatterbox-multilingual-tts', functionId: 'ddacc747-1269-4fab-bfd9-8f593dead106' }
]

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

/*
 * One connection per service, kept open between turns.
 *
 * Every call used to open its own: a fresh TLS handshake and HTTP/2 setup
 * to grpc.nvcf.nvidia.com before a word could be heard or said, then closed
 * again. That is most of the "one Mississippi, two Mississippi" between the
 * answer arriving and hearing it - measured as 2.8 to 4.1s for a four-letter
 * answer, and worse on a phone's hotspot, where every round trip is longer.
 * gRPC multiplexes calls over one channel, and the key goes in per call, so
 * one channel serves every key in the rotation.
 */
const clients = new Map<grpc.ServiceClientConstructor, grpc.Client>()

function clientFor(Client: grpc.ServiceClientConstructor): grpc.Client {
  let client = clients.get(Client)
  if (!client) {
    client = new Client(HOST, grpc.credentials.createSsl(), {
      /* Without this a channel left alone for a while is found dead only by
         the next call, which then waits out the reconnect. */
      'grpc.keepalive_time_ms': 60_000,
      'grpc.keepalive_timeout_ms': 10_000
    })
    clients.set(Client, client)
  }
  return client
}

/** A channel that failed is dropped, so the next call starts a clean one. */
function dropClient(Client: grpc.ServiceClientConstructor, code: number | undefined): void {
  if (code !== grpc.status.UNAVAILABLE && code !== grpc.status.INTERNAL && code !== grpc.status.UNKNOWN) return
  clients.get(Client)?.close()
  clients.delete(Client)
  answeredAt.delete(Client)
}

/*
 * THE FIRST REQUEST ON A CONNECTION IS SLOW.
 *
 * Measured with `wumpy --speech-check` on fresh channels, already connected:
 * 1.0-2.1s to hear 5.9s of speech the first time and 0.6s the next, and
 * 1.5-1.7s for "Five." against 0.4s to the first sound after. Not the
 * handshake, which had finished - NVIDIA's side, setting up the first call on
 * a connection. In a voice turn the first request is the transcript of what
 * was just said, and a phone's hotspot drops idle connections between turns,
 * so this was waited out on nearly every turn, and again before the first
 * word of the answer.
 *
 * So a turn primes each service while the person is still talking, with the
 * smallest real request there is - a fifth of a second of silence to hear,
 * one word to say - unless the service answered within WARM_FOR_MS and its
 * connection is warm anyway.
 */
export const WARM_FOR_MS = 60_000
const answeredAt = new Map<grpc.ServiceClientConstructor, number>()

function answered(Client: grpc.ServiceClientConstructor): void {
  answeredAt.set(Client, Date.now())
}

/** Which services would keep the person waiting on a cold connection. */
export function coldSpeech(): { hear: boolean; talk: boolean } {
  let services: Loaded
  try {
    services = load()
  } catch {
    return { hear: false, talk: false }
  }
  const cold = (Client: grpc.ServiceClientConstructor): boolean =>
    !clients.has(Client) || Date.now() - (answeredAt.get(Client) ?? 0) > WARM_FOR_MS
  return { hear: cold(services.asr), talk: cold(services.tts) }
}

/** A fifth of a second of silence, heard: the slow first request, spent early. */
export async function primeHearing(borrowed: BorrowedKey): Promise<number> {
  const started = Date.now()
  await recognize(wavFrom(Buffer.alloc(6400), 16000), borrowed)
  return Date.now() - started
}

/** One word, said and thrown away: the same, for the voice. */
export async function primeTalking(borrowed: BorrowedKey, voice = DEFAULT_VOICE): Promise<number> {
  const started = Date.now()
  await synthesizeStream('Okay.', borrowed, voice, () => {})
  return Date.now() - started
}

/**
 * Connects both channels now, so the handshake happens while the person is
 * still talking rather than after. Called when a voice turn starts. Free:
 * no request is made and no key is spent.
 */
export function warmSpeech(): Promise<number> {
  const started = Date.now()
  let services: Loaded
  try {
    services = load()
  } catch {
    return Promise.resolve(-1)
  }
  return Promise.all(
    [services.asr, services.tts].map(
      (Client) =>
        new Promise<void>((resolve) => {
          clientFor(Client).waitForReady(Date.now() + 8000, () => resolve())
        })
    )
  ).then(() => Date.now() - started)
}

/** Closes the channels, for quitting. */
export function closeSpeech(): void {
  for (const client of clients.values()) client.close()
  clients.clear()
  answeredAt.clear()
}

function call<Req, Res>(
  Client: grpc.ServiceClientConstructor,
  method: string,
  request: Req,
  borrowed: BorrowedKey,
  functionId: string,
  timeoutMs: number
): Promise<Res> {
  const client = clientFor(Client)
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
        borrowed.done(httpStatus(err?.code ?? grpc.status.OK))
        if (err) {
          dropClient(Client, err.code)
          reject(new Error(`NVIDIA ${method}: ${err.details || err.message}`))
        } else {
          answered(Client)
          resolve(response)
        }
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
 * What the recogniser heard. `confidence` is the model's own, 0..1, so it can stand
 * where Whisper's did.
 */
export async function recognize(
  wav: Uint8Array,
  borrowed: BorrowedKey,
  hearer: Hearer = HEARING
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
        language_code: hearer.language,
        max_alternatives: 1,
        enable_automatic_punctuation: true,
        audio_channel_count: 1,
        ...(hearer.boost
          ? {
              speech_contexts: [
                { phrases: [...new Set(BOOSTED_WORDS.flatMap((w) => [w, w.toLowerCase()]))], boost: hearer.boost }
              ]
            }
          : {})
      },
      audio: audio.pcm
    },
    borrowed,
    hearer.functionId,
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

/**
 * The voices Magpie offers, by full name ("Magpie-Multilingual.EN-US.Aria"),
 * asked of the service rather than remembered, since NVIDIA adds and renames
 * them. A model lists its voice once and its speakers as subvoices.
 */
export async function listVoices(borrowed: BorrowedKey, functionId = SPEECH_MODELS.talk): Promise<string[]> {
  const response = await call<unknown, { model_config?: Array<{ parameters?: Record<string, string> }> }>(
    load().tts,
    'GetRivaSynthesisConfig',
    {},
    borrowed,
    functionId,
    15_000
  )
  const names = new Set<string>()
  for (const config of response.model_config ?? []) {
    const p = config.parameters ?? {}
    const base = p.voice_name
    if (!base) continue
    const subs = (p.subvoices ?? '').split(',').map((v) => v.split(':')[0].trim()).filter(Boolean)
    if (!subs.length) names.add(base)
    for (const sub of subs) names.add(sub.startsWith(base) ? sub : `${base}.${sub}`)
  }
  return [...names].sort()
}

/** Magpie's voice for `text`, as a WAV file. */
export async function synthesize(
  text: string,
  borrowed: BorrowedKey,
  voice = DEFAULT_VOICE,
  /** Exactly as given, without forMagpie - for `--hearing-check`, to hear what it fixes. */
  asWritten = false,
  /** Another voice model on the same keys: see TALKERS. */
  functionId = SPEECH_MODELS.talk
): Promise<{ wav: Buffer; ms: number }> {
  const started = Date.now()
  const response = await call<unknown, { audio?: Buffer }>(
    load().tts,
    'Synthesize',
    {
      text: asWritten ? text : forMagpie(text),
      language_code: 'en-US',
      encoding: 'LINEAR_PCM',
      sample_rate_hz: TTS_RATE,
      voice_name: voice
    },
    borrowed,
    functionId,
    30_000
  )
  const pcm = response.audio ?? Buffer.alloc(0)
  if (pcm.length === 0) throw new Error('NVIDIA Synthesize returned no audio')
  return { wav: wavFrom(Buffer.from(pcm), TTS_RATE), ms: Date.now() - started }
}

/**
 * Magpie's voice for `text`, delivered as it is made: `onAudio` gets each
 * piece of 16-bit mono PCM at TTS_RATE the moment it arrives, so the first
 * words play while the rest are still being generated.
 *
 * Streamed with SynthesizeOnline; if the service will not stream (it is
 * NVIDIA's choice per model, and has changed before), the same text goes
 * through Synthesize and arrives as one piece. Resolves with the number of
 * pieces sent, and when the first one came.
 */
/** NVIDIA said it does not stream this voice: ask the plain way from then on. */
let onlineRefused = false

export async function synthesizeStream(
  text: string,
  borrowed: BorrowedKey,
  voice: string,
  onAudio: (pcm: Buffer) => void,
  /** Another voice model on the same keys, for `--compare-voices`; what it refuses is not remembered. */
  functionId = SPEECH_MODELS.talk
): Promise<{ pieces: number; firstMs: number; ms: number; streamed: boolean }> {
  const ours = functionId === SPEECH_MODELS.talk
  const started = Date.now()
  const request = {
    text: forMagpie(text),
    language_code: 'en-US',
    encoding: 'LINEAR_PCM',
    sample_rate_hz: TTS_RATE,
    voice_name: voice
  }
  const Client = load().tts
  const metadata = new grpc.Metadata()
  metadata.set('function-id', functionId)
  metadata.set('authorization', `Bearer ${borrowed.key}`)

  let pieces = 0
  let firstMs = -1
  if (onlineRefused && ours) {
    const response = await call<unknown, { audio?: Buffer }>(Client, 'Synthesize', request, borrowed, functionId, 30_000)
    const pcm = response.audio ?? Buffer.alloc(0)
    if (pcm.length === 0) throw new Error('NVIDIA Synthesize returned no audio')
    onAudio(Buffer.from(pcm))
    return { pieces: 1, firstMs: Date.now() - started, ms: Date.now() - started, streamed: false }
  }
  const streamed = await new Promise<{ ok: true } | { ok: false; code: number | undefined; why: string }>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (clientFor(Client) as any).SynthesizeOnline(metadata, { deadline: Date.now() + 30_000 })
    stream.on('data', (response: { audio?: Buffer }) => {
      const pcm = response.audio
      if (!pcm || pcm.length === 0) return
      if (firstMs < 0) firstMs = Date.now() - started
      pieces++
      onAudio(Buffer.from(pcm))
    })
    stream.on('error', (err: grpc.ServiceError) =>
      resolve({ ok: false, code: err.code, why: err.details || err.message })
    )
    stream.on('end', () => resolve({ ok: true }))
    stream.write(request)
    stream.end()
  })

  if (streamed.ok) {
    borrowed.done(200)
    answered(Client)
    if (pieces === 0) throw new Error('NVIDIA SynthesizeOnline returned no audio')
    return { pieces, firstMs, ms: Date.now() - started, streamed: true }
  }
  /* Half an answer already played: saying it again from the top would be
     worse than stopping where it broke. */
  if (pieces > 0) {
    borrowed.done(httpStatus(streamed.code))
    dropClient(Client, streamed.code)
    throw new Error(`NVIDIA SynthesizeOnline broke off: ${streamed.why}`)
  }
  /* A key problem is the same problem on the other method; anything else -
     not streamed here, a dropped channel - is worth one plain try. */
  const status = httpStatus(streamed.code)
  if (status === 401 || status === 403 || status === 429) {
    borrowed.done(status)
    throw new Error(`NVIDIA SynthesizeOnline: ${streamed.why}`)
  }
  if (streamed.code === grpc.status.UNIMPLEMENTED && ours) onlineRefused = true
  dropClient(Client, streamed.code)
  const response = await call<unknown, { audio?: Buffer }>(Client, 'Synthesize', request, borrowed, functionId, 30_000)
  const pcm = response.audio ?? Buffer.alloc(0)
  if (pcm.length === 0) throw new Error('NVIDIA Synthesize returned no audio')
  onAudio(Buffer.from(pcm))
  return { pieces: 1, firstMs: Date.now() - started, ms: Date.now() - started, streamed: false }
}

/**
 * A stall, raced. "First sound 7249ms after asking", on the first answer of
 * a conversation: the voice's own priming took 18.6s that time, against 0.8
 * to 2.3s on every other day in the log, and everything asked of Magpie
 * waited behind it - on the one connection, while hearing on its own
 * connection answered in two. So when nothing has come back HEDGE_AFTER_MS
 * after asking, the same sentence is asked again on a connection of its own
 * with the next key, and whichever starts first is the one played; the
 * other is cancelled. A stuck connection is replaced by the one that
 * answered. One extra request, and only when it is already late.
 */
export const HEDGE_AFTER_MS = 2500

/** One SynthesizeOnline on a given connection, cancellable. Pieces go to `onAudio`. */
function streamOn(
  client: grpc.Client,
  request: unknown,
  borrowed: BorrowedKey,
  onAudio: (pcm: Buffer) => void
): { done: Promise<{ ok: true } | { ok: false; code: number | undefined; why: string }>; cancel(): void } {
  const metadata = new grpc.Metadata()
  metadata.set('function-id', SPEECH_MODELS.talk)
  metadata.set('authorization', `Bearer ${borrowed.key}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (client as any).SynthesizeOnline(metadata, { deadline: Date.now() + 30_000 })
  let cancelled = false
  const done = new Promise<{ ok: true } | { ok: false; code: number | undefined; why: string }>((resolve) => {
    stream.on('data', (response: { audio?: Buffer }) => {
      if (!cancelled && response.audio?.length) onAudio(Buffer.from(response.audio))
    })
    stream.on('error', (err: grpc.ServiceError) => resolve({ ok: false, code: err.code, why: err.details || err.message }))
    stream.on('end', () => resolve({ ok: true }))
  })
  stream.write(request)
  stream.end()
  return {
    done,
    cancel: () => {
      cancelled = true
      stream.cancel()
    }
  }
}

export async function synthesizeHedged(
  text: string,
  borrow: () => Promise<BorrowedKey | null>,
  voice: string,
  onAudio: (pcm: Buffer) => void,
  hedgeMs = HEDGE_AFTER_MS
): Promise<{ pieces: number; firstMs: number; ms: number; streamed: boolean; raced: boolean } | null> {
  const first = await borrow()
  if (!first) return null
  /* Not streamed for this voice, as NVIDIA has decided before: the plain
     way, as synthesizeStream does it, with nothing to race. */
  if (onlineRefused) return { ...(await synthesizeStream(text, first, voice, onAudio)), raced: false }
  const Client = load().tts
  const request = { text: forMagpie(text), language_code: 'en-US', encoding: 'LINEAR_PCM', sample_rate_hz: TTS_RATE, voice_name: voice }
  const started = Date.now()
  type Ended = { ok: true } | { ok: false; code: number | undefined; why: string }
  interface Run {
    run: ReturnType<typeof streamOn>
    key: BorrowedKey
    client: grpc.Client
    fresh: boolean
    ended: Ended | null
  }
  const runs: Run[] = []
  let winner: number | null = null
  let pieces = 0
  let firstMs = -1
  const begin = (key: BorrowedKey, client: grpc.Client, fresh: boolean): void => {
    const which = runs.length
    const run = streamOn(client, request, key, (pcm) => {
      if (winner === null) {
        winner = which
        firstMs = Date.now() - started
        for (const [i, other] of runs.entries()) if (i !== which) other.run.cancel()
      }
      if (winner !== which) return
      pieces++
      onAudio(pcm)
    })
    const entry: Run = { run, key, client, fresh, ended: null }
    runs.push(entry)
    void run.done.then((ended) => {
      entry.ended = ended
    })
  }
  begin(first, clientFor(Client), false)

  /* The second asking, if the first is still silent when it is due. */
  let raceSettled = false
  let giveUp = false
  const timer = setTimeout(async () => {
    if (winner !== null || giveUp) {
      raceSettled = true
      return
    }
    const k = await borrow()
    if (!k || winner !== null || giveUp) {
      k?.done(200)
      raceSettled = true
      return
    }
    console.log(`[wumpy] Magpie had said nothing ${Date.now() - started}ms after asking: asked again on a new connection`)
    begin(k, new Client(HOST, grpc.credentials.createSsl(), { 'grpc.keepalive_time_ms': 60_000, 'grpc.keepalive_timeout_ms': 10_000 }), true)
    raceSettled = true
  }, hedgeMs)

  /* Until one is heard, or every one has ended without a sound. Polled:
     the second may not exist yet when this starts waiting. */
  while (winner === null) {
    const allEnded = runs.every((r) => r.ended)
    /* The first failed outright before the second was due: no waiting for it. */
    if (allEnded && !raceSettled && runs.length === 1) {
      giveUp = true
      clearTimeout(timer)
      raceSettled = true
    }
    if (allEnded && raceSettled) break
    await new Promise((r) => setTimeout(r, 40))
  }
  clearTimeout(timer)
  giveUp = true

  if (winner === null) {
    for (const r of runs) {
      const status = r.ended && !r.ended.ok ? httpStatus(r.ended.code) : 200
      r.key.done(status)
      if (r.fresh) r.client.close()
    }
    const failed = runs.map((r) => r.ended).find((e): e is Extract<Ended, { ok: false }> => Boolean(e && !e.ok))
    const status = failed ? httpStatus(failed.code) : 200
    if (status === 401 || status === 403 || status === 429) throw new Error(`NVIDIA SynthesizeOnline: ${failed?.why}`)
    if (failed?.code === grpc.status.UNIMPLEMENTED) onlineRefused = true
    if (failed) dropClient(Client, failed.code)
    /* Nothing from any of them: one plain try, as synthesizeStream makes. */
    const k = await borrow()
    if (!k) return null
    const plain = await call<unknown, { audio?: Buffer }>(Client, 'Synthesize', request, k, SPEECH_MODELS.talk, 30_000)
    const pcm = plain.audio ?? Buffer.alloc(0)
    if (pcm.length === 0) throw new Error('NVIDIA Synthesize returned no audio')
    onAudio(Buffer.from(pcm))
    return { pieces: 1, firstMs: Date.now() - started, ms: Date.now() - started, streamed: false, raced: runs.length > 1 }
  }

  const won = runs[winner]
  const ended = await won.run.done
  for (const [i, r] of runs.entries()) {
    if (i === winner) continue
    /* Cancelled is this side's doing; a 429 or a refused key before that is
       the key's, and has to be reported so it rests. */
    const lost = r.ended && !r.ended.ok && r.ended.code !== grpc.status.CANCELLED ? httpStatus(r.ended.code) : 200
    r.key.done(lost)
    if (r.fresh) r.client.close()
  }
  if (!ended.ok) {
    won.key.done(httpStatus(ended.code))
    if (won.fresh) won.client.close()
    else dropClient(Client, ended.code)
    throw new Error(`NVIDIA SynthesizeOnline broke off: ${ended.why}`)
  }
  won.key.done(200)
  /* The new connection answered where the old one sat: it is the one kept. */
  if (won.fresh) {
    clients.get(Client)?.close()
    clients.set(Client, won.client)
  }
  answered(Client)
  return { pieces, firstMs, ms: Date.now() - started, streamed: true, raced: runs.length > 1 }
}

export { TTS_RATE }

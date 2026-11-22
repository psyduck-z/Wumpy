import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import {
  JUDGE_FROM_MS,
  LEARN_CLIPS,
  emptyVoiceprint,
  features,
  voiced,
  judge,
  known,
  learn,
  BINS,
  RATE,
  type Verdict,
  type Voiceprint
} from '@shared/voiceprint'
import type { VoiceprintState, WhoseAnswer } from '@shared/types'

/**
 * The person's voiceprint, and the model that makes one (see
 * shared/voiceprint.ts for what it is for).
 *
 * The model is CAM++ from 3D-Speaker (Apache 2.0), trained on VoxCeleb, as
 * sherpa-onnx publishes it: 29 MB, fetched the first time it is needed and
 * checked against its hash, so the installer and the repo stay as they were.
 * It runs here, in the main process, on onnxruntime's WebAssembly build -
 * the same code on Windows and Linux, nothing native to go wrong - and
 * nothing about the voice leaves the machine.
 *
 * Whatever goes wrong - no network for the download, a model that will not
 * load - everyone is heard, as before. Turning the person away because a
 * download failed would be worse than not knowing their voice.
 */

const MODEL = 'campplus-voxceleb-16k'
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'
const MODEL_SHA256 = '98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5'

/** After a failed download or load, how long before trying again. */
const RETRY_MS = 10 * 60 * 1000

type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>
  inputNames: readonly string[]
  outputNames: readonly string[]
}

const dir = (): string => join(app.getPath('userData'), 'voiceprint')
const printFile = (): string => join(dir(), 'voice.json')
const modelFile = (): string => join(dir(), `${MODEL}.onnx`)

let print: Voiceprint | null = null
let session: Promise<{ session: Session; tensor: (data: Float32Array, dims: number[]) => unknown } | null> | null = null
let failedAt = 0
let log: (line: string) => void = () => {}

export function setVoiceprintLog(l: (line: string) => void): void {
  log = l
}

function load(): Voiceprint {
  if (print) return print
  try {
    const got = JSON.parse(readFileSync(printFile(), 'utf8')) as Voiceprint
    print = got.model === MODEL && Array.isArray(got.clips) ? got : { ...emptyVoiceprint(MODEL), off: got.off }
  } catch {
    print = emptyVoiceprint(MODEL)
  }
  return print
}

function save(next: Voiceprint): void {
  print = next
  mkdirSync(dir(), { recursive: true })
  writeAtomic(printFile(), JSON.stringify(next))
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function fetchModel(): Promise<Uint8Array> {
  const file = modelFile()
  if (existsSync(file)) {
    const have = readFileSync(file)
    if (sha256(have) === MODEL_SHA256) return have
    rmSync(file, { force: true })
  }
  log('[voiceprint] fetching the voice model (29 MB, once)')
  const started = Date.now()
  const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(5 * 60 * 1000) })
  if (!res.ok) throw new Error(`the voice model could not be fetched (HTTP ${res.status})`)
  const got = new Uint8Array(await res.arrayBuffer())
  if (sha256(got) !== MODEL_SHA256) throw new Error('the voice model fetched was not the one expected')
  mkdirSync(dir(), { recursive: true })
  writeFileSync(`${file}.part`, got)
  renameSync(`${file}.part`, file)
  log(`[voiceprint] voice model fetched in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return got
}

function model(): Promise<{ session: Session; tensor: (data: Float32Array, dims: number[]) => unknown } | null> {
  if (session) return session
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null)
  session = (async () => {
    try {
      const bytes = await fetchModel()
      const ort = await import('onnxruntime-web')
      /* One thread: no workers to start from inside the app's archive, and
         a few seconds of talking take a few hundred ms, while the words
         are being heard anyway. */
      ort.env.wasm.numThreads = 1
      const s = (await ort.InferenceSession.create(bytes)) as unknown as Session
      log('[voiceprint] voice model ready')
      return { session: s, tensor: (data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims) }
    } catch (err) {
      log(`[voiceprint] not available, so everyone is heard: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
      failedAt = Date.now()
      session = null
      return null
    }
  })()
  return session
}

/** 16-bit mono PCM out of a WAV, as wav.ts makes them. */
export function wavSamples(wav: ArrayBuffer): { samples: Float32Array; rate: number } | null {
  const view = new DataView(wav)
  if (wav.byteLength < 44) return null
  let at = 12
  let rate = 0
  let bits = 0
  let channels = 1
  while (at + 8 <= wav.byteLength) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      channels = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (id === 'data') {
      if (bits !== 16 || !rate) return null
      const count = Math.floor(Math.min(size, wav.byteLength - at - 8) / 2 / channels)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2 * channels, true) / 32768
      return { samples, rate }
    }
    at += 8 + size + (size & 1)
  }
  return null
}

/** A clip's voiceprint, or null without a model. */
async function embed(samples: Float32Array): Promise<Float32Array | null> {
  const m = await model()
  if (!m) return null
  const { data, frames } = features(voiced(samples))
  if (frames < 10) return null
  const out = await m.session.run({ [m.session.inputNames[0]]: m.tensor(data, [1, frames, BINS]) })
  return out[m.session.outputNames[0]].data
}

/**
 * Whose voice a clip heard in a conversation was. `audio` is the WAV the transcriber is
 * sent (16 kHz mono); `talkedMs` how long the talking in it was.
 */
export async function whose(audio: ArrayBuffer, talkedMs: number, device: string): Promise<WhoseAnswer> {
  const now = load()
  if (now.off) return { kind: 'theirs', score: null, why: 'off' }
  const started = Date.now()
  const wav = wavSamples(audio)
  if (!wav || wav.rate !== RATE) return { kind: 'theirs', score: null, why: 'unavailable' }
  /* Too short to judge, and to learn from, once the voice is known: no
     model run for it. */
  if (known(now) && talkedMs < JUDGE_FROM_MS) return { kind: 'theirs', score: null, why: 'short' }
  let v: Float32Array | null
  try {
    v = await embed(wav.samples)
  } catch (err) {
    log(`[voiceprint] could not be made: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    v = null
  }
  if (!v) return { kind: 'theirs', score: null, why: 'unavailable' }
  const verdict: Verdict = judge(now, v, talkedMs)
  const ms = Date.now() - started
  if (verdict.kind !== 'theirs') return { ...verdict, ms }
  /* Learned from only once it turns out to have been words (see learnFrom):
     a long cough is not a voice to learn. */
  const token = `${started}-${Math.random().toString(36).slice(2, 8)}`
  waiting.set(token, { v, talkedMs, device })
  while (waiting.size > 8) waiting.delete(waiting.keys().next().value as string)
  return { ...verdict, ms, token }
}

/** Clips judged theirs, kept a little while for learnFrom. */
const waiting = new Map<string, { v: Float32Array; talkedMs: number; device: string }>()

/** The clip `whose` answered `token` for was words: learned from, if it should be. True when it was. */
export function learnFrom(token: string): boolean {
  const clip = waiting.get(token)
  waiting.delete(token)
  if (!clip) return false
  const now = load()
  const next = learn(now, clip.v, clip.talkedMs, clip.device)
  if (next === now) return false
  save(next)
  if (now.clips.length < LEARN_CLIPS && next.clips.length >= LEARN_CLIPS)
    log(`[voiceprint] your voice is known now (${LEARN_CLIPS} clips): other voices are not answered from here on`)
  return true
}

/** Loads the model now, if it will be wanted: a conversation is starting. */
export function warmVoiceprint(): void {
  if (!load().off) void model()
}

export function voiceprintState(): VoiceprintState {
  const p = load()
  return {
    on: !p.off,
    clips: p.clips.length,
    needed: LEARN_CLIPS,
    known: known(p),
    devices: [...new Set(p.clips.map((c) => c.device).filter(Boolean))]
  }
}

/** Turned on or off, or forgotten: learning starts again from the next conversation. */
export function setVoiceprint(change: { on?: boolean; forget?: boolean }): VoiceprintState {
  const p = load()
  let next: Voiceprint = p
  if (change.forget) next = { ...emptyVoiceprint(MODEL), off: p.off }
  if (change.on !== undefined) next = { ...next, off: change.on ? undefined : true }
  save(next)
  return voiceprintState()
}

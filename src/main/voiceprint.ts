import { app, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import workerPath from './voiceprintworker?modulePath'
import {
  ENROL_CLIPS,
  JUDGE_FROM_MS,
  LEARN_CLIPS,
  LEARN_FROM_MS,
  calibrated,
  emptyVoiceprint,
  enrolCheck,
  enrolled,
  judge,
  known,
  learn,
  steadiness,
  RATE,
  type Clip,
  type Verdict,
  type Voiceprint
} from '@shared/voiceprint'
import type { EnrolAnswer, VoiceprintState, WhoseAnswer } from '@shared/types'

/**
 * The person's voiceprint, and the model that makes one (see
 * shared/voiceprint.ts for what it is for).
 *
 * The model is CAM++ from 3D-Speaker (Apache 2.0), trained on VoxCeleb, as
 * sherpa-onnx publishes it: 29 MB, fetched the first time it is needed and
 * checked against its hash, so the installer and the repo stay as they were.
 * It runs in a utility process of its own (voiceprintworker.ts), on
 * onnxruntime's WebAssembly build - the same code on Windows and Linux,
 * nothing native to go wrong, and nothing in the main process held up while
 * it works - and nothing about the voice leaves the machine.
 *
 * Whatever goes wrong - no network for the download, a model that will not
 * load - everyone is heard, as before. Turning the person away because a
 * download failed would be worse than not knowing their voice. The one
 * exception is a yes or no to something about to run, once their voice is
 * known: that is not taken unless it can be told to be theirs (see whose).
 */

const MODEL = 'campplus-voxceleb-16k'
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'
const MODEL_SHA256 = '98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5'

/** After a failed download or load, how long before trying again. */
const RETRY_MS = 10 * 60 * 1000
/** Longer than any clip takes (30s took 4.4s on the main thread): past it, the worker is stuck. */
const EMBED_TIMEOUT_MS = 20_000
const LOAD_TIMEOUT_MS = 60_000

const dir = (): string => join(app.getPath('userData'), 'voiceprint')
const printFile = (): string => join(dir(), 'voice.json')
const modelFile = (): string => join(dir(), `${MODEL}.onnx`)

let print: Voiceprint | null = null
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

/** The model on disk, fetched and checked if it is not there yet. */
async function fetchModel(): Promise<string> {
  const file = modelFile()
  if (existsSync(file)) {
    if (sha256(readFileSync(file)) === MODEL_SHA256) return file
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
  return file
}

// ---------------------------------------------------------------------------
// The worker.
// ---------------------------------------------------------------------------

type Reply = { id: number; ok: boolean; error?: string; v?: Float32Array | null; talkedMs?: number }

interface Worker {
  ask(message: Record<string, unknown>, timeoutMs: number): Promise<Reply>
}

let worker: Promise<Worker | null> | null = null

function spawn(): Worker & { child: UtilityProcess; ready: Promise<void> } {
  const child = utilityProcess.fork(workerPath, [], { serviceName: 'Wumpy voiceprint', stdio: 'pipe' })
  child.stderr?.on('data', (d) => log(`[voiceprint] worker: ${String(d).trim().slice(0, 300)}`))
  let next = 1
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const failAll = (why: string): void => {
    for (const w of waiting.values()) {
      clearTimeout(w.timer)
      w.reject(new Error(why))
    }
    waiting.clear()
  }
  child.on('message', (reply: Reply) => {
    const w = waiting.get(reply.id)
    if (!w) return
    waiting.delete(reply.id)
    clearTimeout(w.timer)
    w.resolve(reply)
  })
  child.on('exit', (code) => {
    log(`[voiceprint] worker ended (${code})`)
    failAll('the voiceprint worker ended')
    /* Started again the next time one is wanted. */
    worker = null
  })
  const spawned = new Promise<void>((resolve) => child.once('spawn', () => resolve()))
  const ask = (message: Record<string, unknown>, timeoutMs: number): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`the voiceprint worker did not answer in ${timeoutMs / 1000}s`))
        child.kill()
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      child.postMessage({ ...message, id })
    })
  return { child, ready: spawned, ask }
}

function model(): Promise<Worker | null> {
  if (worker) return worker
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null)
  let started: Promise<Worker | null> | null = null
  started = (async (): Promise<Worker | null> => {
    try {
      const file = await fetchModel()
      const w = spawn()
      await w.ready
      const loaded = await w.ask({ kind: 'load', file }, LOAD_TIMEOUT_MS)
      if (!loaded.ok) {
        w.child.kill()
        throw new Error(loaded.error ?? 'the voice model would not load')
      }
      log('[voiceprint] voice model ready')
      return w
    } catch (err) {
      log(`[voiceprint] not available, so everyone is heard: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
      failedAt = Date.now()
      if (worker === started) worker = null
      return null
    }
  })()
  worker = started
  return started
}

/** 16-bit mono PCM out of a WAV, as wav.ts makes them. */
export function wavSamples(wav: ArrayBuffer): { samples: Float32Array; rate: number } | null {
  if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44) return null
  const view = new DataView(wav)
  let at = 12
  let rate = 0
  let bits = 0
  let channels = 1
  while (at + 8 <= wav.byteLength) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      if (at + 24 > wav.byteLength) return null
      channels = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (id === 'data') {
      if (bits !== 16 || !rate || channels < 1) return null
      const count = Math.floor(Math.min(size, wav.byteLength - at - 8) / 2 / channels)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2 * channels, true) / 32768
      return { samples, rate }
    }
    at += 8 + size + (size & 1)
  }
  return null
}

/** A clip's voiceprint and how much talking it had, or null without a model (or without enough talking). */
async function embed(samples: Float32Array): Promise<{ v: Float32Array; talkedMs: number } | null> {
  const w = await model()
  if (!w) return null
  const reply = await w.ask({ kind: 'embed', samples }, EMBED_TIMEOUT_MS)
  if (!reply.ok) throw new Error(reply.error ?? 'the voiceprint could not be made')
  return reply.v ? { v: reply.v, talkedMs: reply.talkedMs ?? 0 } : null
}

// ---------------------------------------------------------------------------
// Judging what is heard in a conversation.
// ---------------------------------------------------------------------------

/**
 * Whose voice a clip heard in a conversation was. `audio` is the WAV the
 * transcriber is sent (16 kHz mono); `talkedMs` how long the talking in it
 * was. `answer`: a yes or no to something about to run - judged however
 * short, and once the voice is known, not counted as theirs unless it can
 * be told to be.
 */
export async function whose(audio: ArrayBuffer, talkedMs: number, device: string, answer = false): Promise<WhoseAnswer> {
  const now = load()
  if (now.off) return { kind: 'theirs', score: null, why: 'off' }
  const guarded = answer && known(now)
  const unsure = (): WhoseAnswer =>
    guarded ? { kind: 'someone else', score: null, why: 'unsure' } : { kind: 'theirs', score: null, why: 'unavailable' }
  const started = Date.now()
  const wav = wavSamples(audio)
  if (!wav || wav.rate !== RATE) return unsure()
  /* Too short to judge, and to learn from, once the voice is known: no
     model run for it - unless it is an answer. */
  if (!answer && known(now) && talkedMs < JUDGE_FROM_MS) return { kind: 'theirs', score: null, why: 'short' }
  /* Not known yet, and too short to learn from: nothing a voiceprint would change. */
  if (!known(now) && talkedMs < LEARN_FROM_MS) return { kind: 'theirs', score: null, why: 'learning' }
  let got: { v: Float32Array; talkedMs: number } | null
  try {
    got = await embed(wav.samples)
  } catch (err) {
    log(`[voiceprint] could not be made: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    got = null
  }
  if (!got) return unsure()
  const verdict: Verdict = judge(now, got.v, talkedMs, answer)
  const ms = Date.now() - started
  if (verdict.kind !== 'theirs') return { ...verdict, ms }
  /* Learned from only once it turns out to have been words (see learnFrom):
     a long cough is not a voice to learn. */
  const token = `${started}-${Math.random().toString(36).slice(2, 8)}`
  waiting.set(token, { v: got.v, talkedMs, device })
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
  if (!known(now) && known(next))
    log(`[voiceprint] your voice is known now (${LEARN_CLIPS} clips): other voices are not answered from here on`)
  return true
}

/** Loads the model now, if it will be wanted: a conversation is starting. */
export function warmVoiceprint(): void {
  if (!load().off) void model()
}

// ---------------------------------------------------------------------------
// Calibrating.
// ---------------------------------------------------------------------------

/** The sentences read so far in the calibration under way. */
let reading: Clip[] = []
let readingDevice = ''

/** A calibration starts: nothing read yet, and the model on its way. */
export async function enrolStart(): Promise<{ ready: boolean; needed: number }> {
  reading = []
  readingDevice = ''
  /* Asked for on purpose: a download that failed earlier is tried again now. */
  failedAt = 0
  const w = await model()
  return { ready: Boolean(w), needed: ENROL_CLIPS }
}

/** One sentence read: taken, or why not. */
export async function enrolClip(audio: ArrayBuffer, device: string): Promise<EnrolAnswer> {
  const base = { needed: ENROL_CLIPS }
  const wav = wavSamples(audio)
  if (!wav || wav.rate !== RATE) return { ...base, ok: false, why: 'unavailable', count: reading.length, score: null }
  let got: { v: Float32Array; talkedMs: number } | null
  try {
    got = await embed(wav.samples)
  } catch (err) {
    log(`[voiceprint] calibration clip could not be made: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    return { ...base, ok: false, why: 'unavailable', count: reading.length, score: null }
  }
  if (!got) {
    const w = await model()
    return { ...base, ok: false, why: w ? 'short' : 'unavailable', count: reading.length, score: null }
  }
  const check = enrolCheck(reading, got.v, got.talkedMs)
  if (!check.ok) {
    if (check.restart) reading = []
    log(
      `[voiceprint] calibration: sentence not taken (${check.why}${check.score === null ? '' : `, ${check.score.toFixed(2)}`}` +
        `${check.restart ? ', starting again' : ''})`
    )
    return { ...base, ok: false, why: check.why, restart: Boolean(check.restart), count: reading.length, score: check.score }
  }
  reading.push({ v: Array.from(got.v), at: Date.now(), ms: got.talkedMs, device })
  readingDevice = device
  log(`[voiceprint] calibration: sentence ${reading.length} of ${ENROL_CLIPS} taken${check.score === null ? '' : ` (${check.score.toFixed(2)})`}`)
  return { ...base, ok: true, count: reading.length, score: check.score }
}

/** Enough sentences read: the voice is known from them. */
export function enrolFinish(): VoiceprintState {
  if (reading.length < ENROL_CLIPS) return voiceprintState()
  const steady = steadiness(reading)
  const before = load()
  const next = enrolled(before, reading)
  save(next)
  const kept = next.clips.length - reading.length
  const dropped = before.clips.filter((c) => !c.enrolled).length - kept
  log(
    `[voiceprint] calibrated from ${reading.length} sentences on ${readingDevice || 'the default mic'}` +
      `${steady === null ? '' : `, steadiness ${steady.toFixed(2)}`}; ${kept} clips learned before kept, ${dropped} dropped as not theirs`
  )
  reading = []
  return { ...voiceprintState(), steadiness: steady }
}

export function enrolCancel(): void {
  reading = []
}

// ---------------------------------------------------------------------------
// The state, and turning it off.
// ---------------------------------------------------------------------------

export function voiceprintState(): VoiceprintState {
  const p = load()
  const read = p.clips.filter((c) => c.enrolled)
  return {
    on: !p.off,
    clips: p.clips.length,
    needed: LEARN_CLIPS,
    known: known(p),
    calibrated: calibrated(p),
    calibratedOn: read.length ? read[read.length - 1].device || null : null,
    calibratedAt: read.length ? read[read.length - 1].at : null,
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

import { nextBatch } from '@shared/speakahead'
import { output } from './earcons'

/**
 * Speaks sentences as Magpie makes them.
 *
 * Asked for in these words: "it outputs it, but it takes like 1
 * Mississippi, 2 Mississippi, and then it says it." The whole answer used
 * to be synthesised in one request, over a connection opened for it, and
 * only played once every byte was back. Now each piece of sound is played
 * the moment it arrives (main streams it from SynthesizeOnline), sentences
 * are handed over while the model is still writing the next ones (see
 * shared/speakahead), and the next batch is being made while this one is
 * heard. The pieces are scheduled back to back on one audio clock, so
 * there is no gap where one request ends and the next begins.
 *
 * A sentence Magpie cannot say goes to the system's voice instead, in its
 * place in the order, so an answer is never silently missing a part.
 */
export interface SpeakerHooks {
  /** Sound has started after a silence: the ticks stop here. */
  onSound(): void
  note(line: string): void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let nextId = 0
const receivers = new Map<string, (pcm: ArrayBuffer) => void>()
let listening = false

function receive(): void {
  if (listening) return
  listening = true
  window.wumpy.voice.onAudio(({ id, pcm }) => receivers.get(id)?.(pcm))
}

/** Magpie's rate; each request's answer confirms it. */
const RATE = 22050

export class Speaker {
  /** The turn's output (see earcons.ts), shared so it is already awake. */
  private context: AudioContext | null = null
  /** Everything this speaker plays goes through here, so stop() can cut it. */
  private bus: GainNode | null = null
  /** When the next piece of sound starts, on the context's clock. */
  private at = 0
  private readonly live = new Set<AudioBufferSourceNode>()
  private readonly waiting: string[] = []
  private pump: Promise<void> | null = null
  private stopped = false
  /** When the last scheduled sound ends, in page time - for idleFor(). */
  private endsAt = 0
  private requests = 0

  constructor(private readonly hooks: SpeakerHooks) {
    receive()
  }

  /** Queues sentences to be said after everything already queued. */
  say(sentences: string[]): void {
    if (this.stopped || !sentences.length) return
    this.waiting.push(...sentences)
    if (!this.pump) this.pump = this.run().finally(() => (this.pump = null))
  }

  /** Something is queued, being made, or still playing. */
  busy(): boolean {
    return this.waiting.length > 0 || this.pump !== null || this.ahead() > 0.02
  }

  /** How long it has been quiet, in ms; 0 while it is talking. */
  idleFor(): number {
    return this.busy() ? 0 : Math.max(0, Date.now() - this.endsAt)
  }

  /** Until everything queued has been said, or it is stopped. */
  async drain(): Promise<void> {
    while (!this.stopped && (this.pump || this.waiting.length)) await (this.pump ?? sleep(20))
    while (!this.stopped && this.ahead() > 0.02) await sleep(Math.min(200, this.ahead() * 1000))
  }

  /** Silence at once, and nothing more from this speaker. */
  stop(): void {
    this.stopped = true
    this.waiting.length = 0
    for (const s of this.live) {
      try {
        s.stop()
      } catch {
        /* already ended */
      }
    }
    this.live.clear()
    if ('speechSynthesis' in window) speechSynthesis.cancel()
    this.bus?.disconnect()
    this.bus = null
    this.context = null
  }

  /** Seconds of sound already scheduled and not yet heard. */
  private ahead(): number {
    if (!this.context || this.context.state === 'closed') return 0
    return Math.max(0, this.at - this.context.currentTime)
  }

  private async run(): Promise<void> {
    while (!this.stopped && this.waiting.length) {
      /* One sentence when nothing is playing, so the first sound comes as
         soon as it can; more while something is, since there is time. */
      const batch = nextBatch(this.waiting, this.ahead() < 0.4)
      this.waiting.splice(0, batch.length)
      const text = batch.join(' ')
      if (!(await this.magpie(text)) && !this.stopped) await this.systemVoice(text)
    }
  }

  private async magpie(text: string): Promise<boolean> {
    const id = `say-${++nextId}`
    const asked = Date.now()
    let got = 0
    let first = -1
    let all: () => void = () => {}
    let wanted = Infinity
    receivers.set(id, (pcm) => {
      if (first < 0) first = Date.now() - asked
      got++
      this.play(pcm)
      if (got >= wanted) all()
    })
    try {
      const result = await window.wumpy.voice.speakStream(id, text).catch(() => null)
      if (!result || this.stopped) return got > 0
      /* The pieces are sent before the answer, and arrive first; this only
         covers a straggler. */
      wanted = result.pieces
      if (got < wanted) await Promise.race([new Promise<void>((r) => (all = r)), sleep(1500)])
      this.requests++
      if (this.requests <= 3)
        this.hooks.note(
          `said ${text.length} characters: first sound ${first}ms after asking` +
            `${result.streamed ? `, ${result.pieces} pieces as it was made` : ', in one piece'}`
        )
      return got > 0
    } finally {
      receivers.delete(id)
    }
  }

  private play(pcm: ArrayBuffer): void {
    if (this.stopped || pcm.byteLength < 2) return
    /* The turn's output, which is closed while the mic is open and opened
       again after, so it is asked for each time rather than kept. */
    const current = output()
    if (!current) return
    if (current !== this.context) {
      this.context = current
      this.bus = current.createGain()
      this.bus.connect(current.destination)
      this.at = 0
    }
    const context = current
    const samples = new Int16Array(pcm, 0, pcm.byteLength >> 1)
    const buffer = context.createBuffer(1, samples.length, RATE)
    const out = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.bus!)
    const quiet = this.ahead() <= 0.02
    const start = Math.max(this.at, context.currentTime + 0.03)
    source.start(start)
    this.at = start + buffer.duration
    this.endsAt = Date.now() + (this.at - context.currentTime) * 1000
    this.live.add(source)
    source.onended = () => this.live.delete(source)
    if (quiet) this.hooks.onSound()
  }

  private async systemVoice(text: string): Promise<void> {
    if (!('speechSynthesis' in window)) return
    while (!this.stopped && this.ahead() > 0.02) await sleep(Math.min(200, this.ahead() * 1000))
    if (this.stopped) return
    this.hooks.note('Magpie gave nothing for a sentence; the system voice says it')
    this.hooks.onSound()
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      speechSynthesis.speak(utterance)
      // A machine with no speech engine never fires onend.
      setTimeout(resolve, Math.min(60_000, 2500 + text.length * 80))
    })
    this.endsAt = Date.now()
  }
}

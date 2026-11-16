import { nextBatch } from '@shared/speakahead'
import { output } from './earcons'
import { Stretcher } from './stretch'

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

/** Sound held back before a stretch starts, to ride out a late piece. */
export const CUSHION_S = 0.2

/** How fast answers are said, from the speakRate setting; see stretch.ts. */
let speed = 1
export function setSpeed(next: number): void {
  speed = Number.isFinite(next) && next >= 0.7 && next <= 1.6 ? next : 1
}
export function currentSpeed(): number {
  return speed
}

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
  /** Settles once every batch asked for so far has all its sound scheduled. */
  private tail: Promise<void> = Promise.resolve()
  /** Each batch with all its sound scheduled: how many sentences, and when they end. */
  private readonly finished: Array<{ count: number; endsAt: number }> = []
  /** Wakes the pump when new sentences arrive while it waits on the tail. */
  private kick: () => void = () => {}

  constructor(private readonly hooks: SpeakerHooks) {
    receive()
  }

  /** Queues sentences to be said after everything already queued. */
  say(sentences: string[]): void {
    if (this.stopped || !sentences.length) return
    this.waiting.push(...sentences)
    this.kick()
    if (!this.pump) this.pump = this.run().finally(() => (this.pump = null))
  }

  /**
   * How many of the sentences handed over have been heard to the end - by
   * batch, so a batch cut short counts as not heard. For carrying on after
   * a cough or an "mm-hm" is taken for talking over it.
   */
  heard(): number {
    const now = this.context && this.context.state !== 'closed' ? this.context.currentTime : Infinity
    return this.finished.filter((f) => f.endsAt <= now + 0.05).reduce((n, f) => n + f.count, 0)
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

  /*
   * Two batches in flight at once, played strictly in order.
   *
   * "Sometimes it jitters." One cause was here: the next batch was only
   * asked for once the last piece of the current one had arrived, so after
   * a short first sentence - "Five." is half a second of sound, made in
   * about as long - there was nothing left to play while the next request
   * went out and came back. Now the next batch is asked for straight away
   * and its sound is held until everything before it is scheduled.
   */
  private async run(): Promise<void> {
    const running: Promise<void>[] = []
    for (;;) {
      while (!this.stopped && this.waiting.length) {
        if (running.length >= 2) await running.shift()
        if (this.stopped || !this.waiting.length) break
        /* One sentence when nothing is playing or coming, so the first
           sound comes as soon as it can; more when there is time. */
        const batch = nextBatch(this.waiting, running.length === 0 && this.ahead() < 0.4)
        this.waiting.splice(0, batch.length)
        const job = this.job(batch.join(' '), this.tail, batch.length)
        this.tail = job
        running.push(job)
      }
      if (this.stopped) return
      const tail = this.tail
      await Promise.race([tail, new Promise<void>((r) => (this.kick = r))])
      this.kick = () => {}
      if (this.stopped) return
      if (!this.waiting.length && tail === this.tail) {
        await tail
        if (!this.waiting.length) return
      }
    }
  }

  /** Asks for one batch now; plays it once everything before it has been. */
  private job(text: string, after: Promise<void>, count = 1): Promise<void> {
    const id = `say-${++nextId}`
    const asked = Date.now()
    const held: ArrayBuffer[] = []
    let released = false
    let got = 0
    let first = -1
    /* One per batch: its pieces run on from each other, and the last is
       let out at the end (see stretch.ts). */
    const stretch = new Stretcher(speed)
    receivers.set(id, (pcm) => {
      if (first < 0) first = Date.now() - asked
      got++
      if (released) this.play(pcm, stretch)
      else held.push(pcm)
    })
    const request = window.wumpy.voice.speakStream(id, text).catch(() => null)
    return (async () => {
      try {
        await after
        released = true
        for (const pcm of held.splice(0)) this.play(pcm, stretch)
        const result = await request
        if (result && got < result.pieces) {
          /* The pieces are sent before the answer and arrive first; this
             only covers a straggler. */
          const deadline = Date.now() + 1500
          while (got < result.pieces && Date.now() < deadline && !this.stopped) await sleep(20)
        }
        if (got) this.schedule(stretch.flush())
        /* These sentences end where the sound scheduled so far ends. */
        if (this.context) this.finished.push({ count, endsAt: this.at })
        if (result && ++this.requests <= 3)
          this.hooks.note(
            `said ${text.length} characters: first sound ${first}ms after asking` +
              `${result.streamed ? `, ${result.pieces} pieces as it was made` : ', in one piece'}`
          )
        if (!got && !this.stopped) await this.systemVoice(text)
      } finally {
        receivers.delete(id)
      }
    })()
  }

  private play(pcm: ArrayBuffer, stretch: Stretcher): void {
    if (this.stopped || pcm.byteLength < 2) return
    const samples = new Int16Array(pcm, 0, pcm.byteLength >> 1)
    const floats = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768
    this.schedule(stretch.push(floats))
  }

  private schedule(samples: Float32Array): void {
    if (this.stopped || samples.length === 0) return
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
    const buffer = context.createBuffer(1, samples.length, RATE)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.bus!)
    /* A cushion before the first piece of a stretch, and again after a
       piece came too late: pieces arrive over the network a fifth of a
       second of sound at a time, and playing each the instant it lands
       left a gap at every hiccup - the other half of "it jitters". */
    const quiet = this.ahead() <= 0.02
    const start = Math.max(this.at, context.currentTime + (quiet ? CUSHION_S : 0.03))
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
      utterance.rate = speed
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      speechSynthesis.speak(utterance)
      // A machine with no speech engine never fires onend.
      setTimeout(resolve, Math.min(60_000, 2500 + text.length * 80))
    })
    this.endsAt = Date.now()
  }
}

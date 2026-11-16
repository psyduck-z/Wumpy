/**
 * The sounds a voice turn makes that are not words: the chimes, and the
 * soft typing while it works.
 *
 * Made here with Web Audio rather than played from files, so they cost
 * nothing to ship and can vary a little each time, the way a real key does.
 * Loudness was set by comparing A-weighted energy against the sounds they
 * replaced (scripts/check-speakahead.mjs renders both and compares), since
 * "a titchy bit louder" is about 1.5 dB and not something to guess at.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/*
 * ONE OUTPUT, AWAKE FOR THE WHOLE TURN.
 *
 * Reported in these words: "there was no chime, so I thought it didn't
 * work." The log shows the chime's turn exactly as it should be - mic live
 * after 122ms, chime, listening - and nothing heard, because nothing was
 * said. The chime had played into earbuds that were asleep: the audio
 * system suspends a Bluetooth output a few seconds after the last sound,
 * waking it takes a few hundred milliseconds, and the whole chime is 0.3s.
 * Every sound also opened an output of its own, so any of them - the chime,
 * the first typing, the first word of an answer - could land in that gap.
 *
 * So a turn opens one output when it starts and keeps it awake with a
 * signal far below hearing (about -80 dB: a hiss no earbud can reproduce
 * at any volume), and every sound in the turn goes through it. The first
 * chime waits until the output has had WAKE_MS to come up, which mostly
 * overlaps with the microphone opening anyway.
 */
export const WAKE_MS = 450

/*
 * Longer, after a quiet spell: "sometimes it doesn't work at the start...
 * the initial time to tell me that it received the gesture." The first pinch
 * after a while finds earbuds that have let their audio link go entirely,
 * not just paused it, and a short first chime can be over before they are
 * back. A turn soon after another finds them awake and waits WAKE_MS.
 */
export const WAKE_COLD_MS = 700
const COLD_AFTER_MS = 30_000

let out: { context: AudioContext; keep: AudioBufferSourceNode; woke: number; wake: number } | null = null
/** When the last output was let go; 0, never, counts as cold. */
let closedAt = 0
/** The output device, by id; null is the system's default. See playOn. */
let sink: string | null = null

/**
 * Sends every sound to this output device from now on (null: the default).
 *
 * For a conversation on Windows, where earbuds in headset mode can be an
 * output of their own ("Headset ... Hands-Free"), apart from the
 * "Headphones" one music plays on - and with the earbuds' mic held open
 * for a whole conversation, the default would be the one that has gone
 * quiet. An open output on another device is closed, to be opened again
 * on this one.
 */
export function playOn(id: string | null): void {
  if (id === sink) return
  sink = id
  if (out) {
    releaseOutput()
    wakeOutput()
  }
}

/** An output on the chosen device - or, if that one will not open, on the default. */
function openContext(): AudioContext {
  if (sink) {
    try {
      return new AudioContext({ latencyHint: 'playback', sinkId: sink } as AudioContextOptions)
    } catch {
      sink = null
    }
  }
  return new AudioContext({ latencyHint: 'playback' })
}

/** Opens the turn's output and keeps it awake. Called when a turn starts. */
export function wakeOutput(): void {
  if (out) return
  try {
    /* 'playback': larger buffers, so a busy moment on the page is not a
       click in the ear. Nothing here needs the last few milliseconds. */
    const context = openContext()
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 1e-4
    const keep = context.createBufferSource()
    keep.buffer = buffer
    keep.loop = true
    keep.connect(context.destination)
    keep.start()
    const cold = Date.now() - closedAt > COLD_AFTER_MS
    out = { context, keep, woke: Date.now(), wake: cold ? WAKE_COLD_MS : WAKE_MS }
  } catch {
    /* no sound device: every sound below is skipped */
  }
}

/** Lets the output sleep again. Called when a turn ends. */
export function releaseOutput(): void {
  stopTicks()
  if (!out) return
  try {
    out.keep.stop()
  } catch {
    /* already stopped */
  }
  void out.context.close()
  out = null
  closedAt = Date.now()
}

/** The turn's output, opened now if no turn opened one. */
export function output(): AudioContext | null {
  if (!out) wakeOutput()
  return out?.context ?? null
}

/** The output, once it has had time to wake. */
async function awake(): Promise<AudioContext | null> {
  const context = output()
  if (!out) return null
  const wait = out.wake - (Date.now() - out.woke)
  if (wait > 0) await sleep(wait)
  return out?.context === context ? context : null
}

/*
 * Chimes.
 *
 * Asked for in these words: "make the chime a bit more distinguishable -
 * like, doo doo - just a titchy bit louder." It was two plain sine beeps,
 * 0.11s each, the same timbre as the ticks, so the two blurred together.
 * Now each note is struck, like a soft mallet on wood: a round fundamental,
 * a quick bright overtone at four times it that gives the "d" of "doo", and
 * a longer ring. About 1.5 dB above the old notes, mostly from ringing
 * longer rather than from a harder hit.
 *
 * Then: "also add a chime after the recording of my voice finished", and
 * "add a chime to tell me when [it] is ready for me to speak", since the
 * first chime has to play before the earbuds switch to headset mode, which
 * can take seconds (see listen() in useVoiceTurn). One for "sent" came and
 * went: "remove the one when it sent it, because there's no need for that."
 *
 * And each one "naturally just distinct... if it's like doo doo going
 * upwards, then it knows that it's ready for me to speak... if the tone is
 * going downwards, it means it's finished." So the shape is the meaning:
 *
 *   opening  one short dot                 got your hold, the mic is coming on
 *   listen   doo-DOO, up a fifth           the mic is on: talk now
 *   done     a chord, rolled downwards     the conversation is over
 *   cancel   one low note, twice           the mic never came on
 *
 * "Cancel" goes nowhere - the same low note, "uh-uh".
 *
 * Then a conversation instead of a turn per pinch, and "I feel like there's
 * chimes everywhere": the mic stays open, so there is one "talk now" at the
 * start and none after; "got it" (the same fifth going down) is gone, since
 * the typing that starts when you stop says it - and a "got it" that came
 * in the middle of a sentence, at a pause, was taken for a false alarm and
 * cut people off.
 *
 * Then: "the initial time to tell me that it received the gesture... has to
 * be a little louder, and make it just a single dot", and for all of them,
 * "smoother and more audible, because these are the ones that give me
 * audible feedback to know what's happening." So the pinch is one short,
 * bright dot as loud as the rest (it had been the quietest, a soft low
 * note, so as not to be taken for "talk now" - but a single short dot is not
 * mistaken for two rising notes, and quiet it was missed). And every chime
 * is louder by a little under 3 dB, rings longer, and comes in over 10ms
 * rather than 6, which rounds off the click at the front of each note.
 */
export const CHIMES = {
  opening: { notes: [659.25], step: 0.13, level: 1.6, ring: 0.15 },
  listen: { notes: [587.33, 880], step: 0.13, level: 1, ring: 0.3 },
  done: { notes: [880, 739.99, 587.33], step: 0.035, level: 0.7, ring: 0.3 },
  cancel: { notes: [261.63, 261.63], step: 0.16, level: 1.1, ring: 0.22 }
} as const

export type ChimeKind = keyof typeof CHIMES

export const CHIME_PEAK = 0.15
/** How long a note takes to come in: long enough not to click. */
export const CHIME_ATTACK = 0.01

function strike(context: AudioContext, bus: AudioNode, hz: number, at: number, level: number, ring: number): void {
  const partial = (freq: number, peak: number, length: number): void => {
    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(peak, at + CHIME_ATTACK)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(gain).connect(bus)
    osc.start(at)
    osc.stop(at + length + 0.02)
  }
  partial(hz, CHIME_PEAK * level, ring)
  partial(hz * 2, CHIME_PEAK * level * 0.15, ring * 0.6)
  /* The "d" of "doo": kept in proportion as the notes got louder. */
  partial(hz * 4, ((0.02 * CHIME_PEAK) / 0.11) * level, 0.05)
}

export async function chime(kind: ChimeKind): Promise<void> {
  stopTicks()
  const { notes, step, level, ring } = CHIMES[kind]
  try {
    const context = await awake()
    if (!context) return
    const bus = context.createGain()
    bus.connect(context.destination)
    notes.forEach((hz, i) => strike(context, bus, hz, context.currentTime + 0.01 + i * step, level, ring))
    /* Back as soon as the last note is struck and mostly rung: the mic
       opens after this, and the tail is quieter than any voice. */
    await sleep((notes.length - 1) * step * 1000 + 160)
    setTimeout(() => bus.disconnect(), 400)
  } catch {
    /* no sound device: the turn goes on without its cue */
  }
}

/*
 * Typing while it thinks.
 *
 * Asked for in these words: "make it like the soft typing of creamy
 * keyboards... keep on going, like 1 2 3, 1 2 3, 1 2 3, and when it finally
 * gives a response, just cut that." Before that it was "tut, tut, tut":
 * a sine blip every 0.55s.
 *
 * A "creamy" key is a muted, low one - a lubed switch bottoming out on a
 * soft plate - so each press is a short burst of noise with the top cut
 * off (low-passed around 1.7kHz, nothing clacky above it) over a quick low
 * knock that drops in pitch, 210Hz to 120Hz. Three presses close together
 * and a rest, over and over. Each press varies a little in timing, tone and
 * weight, or a perfect loop sounds like a machine rather than someone
 * typing.
 *
 * Scheduled on the audio clock a second ahead, not by timers, so the
 * rhythm stays even however busy the page is. It all goes through one
 * gain, and disconnecting that cuts it off mid-group the instant the
 * answer starts.
 */
export const TYPING = {
  /** Between presses within a group of three. */
  gap: 0.12,
  /** From the start of one group to the next. */
  cycle: 0.82,
  /** The noise's peak, and the knock's. Measured +1.5 dB on the old tick. */
  click: 0.32,
  knock: 0.12,
  lowpass: 1700
}

/*
 * Ticking while the earbuds' mic comes on.
 *
 * "In between the time when it's loading the speech to text model, can you
 * add like some dots... like a regular mechanical keyboard, like tick, tick,
 * tick, tick." Nothing loads there: that wait is the earbuds switching into
 * headset mode, which on the MacBook takes from one second to six. But it is
 * a wait, and silent it sounded like nothing happening. So one key at a
 * time, evenly, brighter and clickier than the soft typing in threes that
 * means it is thinking - a different wait, a different sound - and quieter
 * than the chimes on either side of it.
 */
export const WAITING = {
  /** From one tick to the next. */
  every: 0.26,
  click: 0.2,
  knock: 0.06,
  /** A clicky switch: brighter than the creamy one's 1.7kHz. */
  lowpass: 4200
}

type KeySound = { click: number; knock: number; lowpass: number; knockFrom: number; knockTo: number }
const CREAMY: KeySound = { click: TYPING.click, knock: TYPING.knock, lowpass: TYPING.lowpass, knockFrom: 210, knockTo: 120 }
const CLICKY: KeySound = { click: WAITING.click, knock: WAITING.knock, lowpass: WAITING.lowpass, knockFrom: 420, knockTo: 260 }

let typing: { bus: GainNode; timer: ReturnType<typeof setInterval> } | null = null
let noise: AudioBuffer | null = null

function press(context: AudioContext, bus: AudioNode, at: number, weight: number, key: KeySound): void {
  if (!noise || noise.sampleRate !== context.sampleRate) {
    noise = context.createBuffer(1, Math.round(context.sampleRate * 0.05), context.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  const src = context.createBufferSource()
  src.buffer = noise
  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = key.lowpass * (0.88 + Math.random() * 0.24)
  filter.Q.value = 0.8
  const click = context.createGain()
  click.gain.setValueAtTime(0.0001, at)
  click.gain.exponentialRampToValueAtTime(key.click * weight, at + 0.002)
  click.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
  src.connect(filter).connect(click).connect(bus)
  src.start(at)
  src.stop(at + 0.05)

  const knock = context.createOscillator()
  const body = context.createGain()
  knock.type = 'sine'
  knock.frequency.setValueAtTime(key.knockFrom * (0.94 + Math.random() * 0.12), at)
  knock.frequency.exponentialRampToValueAtTime(key.knockTo, at + 0.04)
  body.gain.setValueAtTime(0.0001, at)
  body.gain.exponentialRampToValueAtTime(key.knock * weight, at + 0.003)
  body.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
  knock.connect(body).connect(bus)
  knock.start(at)
  knock.stop(at + 0.06)
}

/** Soft typing in threes while it thinks; one clicky key at a time while the mic comes on. */
export function startTicks(kind: 'thinking' | 'waiting' = 'thinking'): void {
  if (typing || !out) return
  try {
    const context = out.context
    const bus = context.createGain()
    bus.connect(context.destination)
    /* Not before the output is awake, or the first group is lost. */
    const wake = Math.max(0, out.wake - (Date.now() - out.woke)) / 1000
    let next = context.currentTime + 0.02 + wake
    const fill = (): void => {
      while (next < context.currentTime + 1) {
        if (kind === 'waiting') {
          press(context, bus, next + (Math.random() - 0.5) * 0.01, 0.94 + Math.random() * 0.12, CLICKY)
          next += WAITING.every
          continue
        }
        for (let i = 0; i < 3; i++) {
          const jitter = (Math.random() - 0.5) * 0.024
          press(context, bus, next + i * TYPING.gap + jitter, [1, 0.85, 0.95][i] * (0.92 + Math.random() * 0.16), CREAMY)
        }
        next += TYPING.cycle
      }
    }
    fill()
    typing = { bus, timer: setInterval(fill, 250) }
  } catch {
    /* no sound device: the bar on screen still says it is working */
  }
}

export function stopTicks(): void {
  if (!typing) return
  clearInterval(typing.timer)
  typing.bus.disconnect()
  typing = null
}

export function ticking(): boolean {
  return typing !== null
}

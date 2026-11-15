/**
 * The sounds a voice turn makes that are not words: the chimes, and the
 * soft typing while it works.
 *
 * Made here with Web Audio rather than played from files, so they cost
 * nothing to ship and can vary a little each time, the way a real key does.
 * Loudness was set by comparing A-weighted energy against the sounds they
 * replaced (scripts/check-earcons.mjs renders both and compares), since "a
 * titchy bit louder" is about 1.5 dB and not something to guess at.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/*
 * Chimes.
 *
 * Asked for in these words: "make the chime a bit more distinguishable -
 * like, doo doo - just a titchy bit louder." It was two plain sine beeps,
 * 0.11s each, the same timbre as the ticks, so the two blurred together.
 * Now each note is struck, like a soft mallet on wood: a round fundamental,
 * a quick bright overtone at four times it that gives the "d" of "doo", and
 * a longer ring. Up a fifth to start listening, down to finish, low for
 * cancelled. About 1.5 dB above the old notes, mostly from ringing longer
 * rather than from a harder hit.
 */
const CHIMES = {
  listen: [587.33, 880],
  done: [880, 587.33],
  cancel: [293.66, 220]
} as const

export const CHIME_PEAK = 0.11

function strike(context: AudioContext, hz: number, at: number): void {
  const partial = (freq: number, peak: number, ring: number): void => {
    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + ring)
    osc.connect(gain).connect(context.destination)
    osc.start(at)
    osc.stop(at + ring + 0.02)
  }
  partial(hz, CHIME_PEAK, 0.2)
  partial(hz * 2, CHIME_PEAK * 0.15, 0.12)
  partial(hz * 4, 0.02, 0.05)
}

export async function chime(kind: keyof typeof CHIMES): Promise<void> {
  stopTicks()
  const notes = CHIMES[kind]
  const step = 0.13
  try {
    const context = new AudioContext()
    notes.forEach((hz, i) => strike(context, hz, context.currentTime + 0.01 + i * step))
    /* Back as soon as the last note is struck and mostly rung: the mic
       opens after this, and the tail is quieter than any voice. */
    await sleep((notes.length - 1) * step * 1000 + 160)
    setTimeout(() => void context.close(), 400)
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
 * rhythm stays even however busy the page is; closing the context cuts it
 * off mid-group the instant the answer starts.
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

let typing: { context: AudioContext; timer: ReturnType<typeof setInterval>; next: number } | null = null

function press(context: AudioContext, noise: AudioBuffer, at: number, weight: number): void {
  const src = context.createBufferSource()
  src.buffer = noise
  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = TYPING.lowpass * (0.88 + Math.random() * 0.24)
  filter.Q.value = 0.8
  const click = context.createGain()
  click.gain.setValueAtTime(0.0001, at)
  click.gain.exponentialRampToValueAtTime(TYPING.click * weight, at + 0.002)
  click.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
  src.connect(filter).connect(click).connect(context.destination)
  src.start(at)
  src.stop(at + 0.05)

  const knock = context.createOscillator()
  const body = context.createGain()
  knock.type = 'sine'
  knock.frequency.setValueAtTime(210 * (0.94 + Math.random() * 0.12), at)
  knock.frequency.exponentialRampToValueAtTime(120, at + 0.04)
  body.gain.setValueAtTime(0.0001, at)
  body.gain.exponentialRampToValueAtTime(TYPING.knock * weight, at + 0.003)
  body.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
  knock.connect(body).connect(context.destination)
  knock.start(at)
  knock.stop(at + 0.06)
}

export function startTicks(): void {
  if (typing) return
  try {
    const context = new AudioContext()
    const noise = context.createBuffer(1, Math.round(context.sampleRate * 0.05), context.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const state = { context, timer: 0 as unknown as ReturnType<typeof setInterval>, next: context.currentTime + 0.02 }
    const fill = (): void => {
      while (state.next < context.currentTime + 1) {
        for (let i = 0; i < 3; i++) {
          const jitter = (Math.random() - 0.5) * 0.024
          press(context, noise, state.next + i * TYPING.gap + jitter, [1, 0.85, 0.95][i] * (0.92 + Math.random() * 0.16))
        }
        state.next += TYPING.cycle
      }
    }
    fill()
    state.timer = setInterval(fill, 250)
    typing = state
  } catch {
    /* no sound device: the bar on screen still says it is working */
  }
}

export function stopTicks(): void {
  if (!typing) return
  clearInterval(typing.timer)
  void typing.context.close()
  typing = null
}

export function ticking(): boolean {
  return typing !== null
}

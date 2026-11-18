import { useEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/types'
import { approvalQuestion, speakable, spokenCommand, spokenSlash, yesNo, type CommandName } from '@shared/spoken'
import {
  ORDER_NAME,
  isCancel,
  matchSpoken,
  modelSwitchIn,
  numberedSpeech,
  orderingIn,
  placeIn,
  sayModel,
  spokenList
} from '@shared/spokenpick'
import { allCommands } from '../commands'
import { CLOUD_MODELS } from '@shared/cloud'
import { record, strictBar, type Recording } from '../recorder'
import { clipForSpeech } from '../wav'
import { newestPending, runningCount } from '../pending'
import { setHandsFree, takeTold } from '../handsfree'
import { choiceMark, newestChoice, stillWaiting, type AloudChoice, type AloudOption } from '../aloud'
import { setVoiceStopper, showVoice } from '../voiceview'
import { chime, playOn, releaseOutput, startTicks, stopTicks, ticking, wakeOutput } from '../earcons'
import { Speaker, currentSpeed, setSpeed } from '../speaker'
import { readyToSay, sentences } from '@shared/speakahead'
import { interruption, leadInOnly, unfinished } from '@shared/interrupt'

/** Every model by its name, for hearing one asked for in passing. */
const MODEL_NAMES = CLOUD_MODELS.map((m) => ({ id: m.id, names: [m.label] }))

/** Every command and what else it answers to, for hearing one said. */
function commandNames(): CommandName[] {
  return allCommands().map((c) => ({ name: c.name, aliases: c.aliases }))
}

/**
 * A spoken conversation, run from the hidden panel: `wumpy --voice` (holding
 * an earbud, through Nothing X) or the tray.
 *
 * Asked for in these words: "every time I want to speak to [it], I have to
 * click the gesture again... if I press the ear and then hold it, that
 * launches it... toggle it on, like chat feature on, and then when I finish
 * using it, I hold it again... then it turns it off... back and forth
 * conversations... I'm allowed to interrupt this AI and tell it what to do."
 *
 * So one gesture opens a conversation and the next one ends it. In between
 * the microphone stays open: you talk, it answers, you talk again, with no
 * gesture and no chime between. Talking while it answers stops it and it
 * listens - the way you talk over a person. Nobody saying anything for
 * IDLE_END_MS ends it too, so a forgotten conversation does not hold the
 * earbuds in headset mode for the rest of the day.
 *
 * The mic staying open is also what makes it quick. Opening the earbuds'
 * mic switches them into headset mode, which on the MacBook takes one to six
 * seconds and fails as often as not ("Failure in Bluetooth audio
 * transport"); that used to happen on every pinch, and now happens once.
 *
 * Each thing said goes where typing goes - so "slash remember ..." is the
 * /remember command and everything else is a message - and the conversation
 * stays with it until it is really over: through every command the model
 * proposes, each one asked about out loud, and any command still running.
 * Answers are read aloud; code never is.
 *
 * An approval cannot be skipped by staying quiet. The question is asked again
 * until the answer is yes or no, and anything else said is ignored - a reply
 * like "yes, but first..." must not run anything. Clicking the card in the
 * panel answers it too.
 *
 * A question Wumpy asks on screen - which model, which chat, delete it or
 * keep it, or the model's own question - is read out and answered the same
 * way: by name, roughly ("Nemotron super"), or by place ("the second one").
 * A name that fits several gets those several read back, best first. Lists
 * are read a little faster than answers, since they are for skimming.
 *
 * Music playing on the machine is paused for the conversation and picked up
 * again after (see main/music.ts).
 */
interface Deps {
  /** The composer's send: commands, intents and messages all go through it. */
  send(text: string): void
  streaming(): boolean
  messages(): ChatMessage[]
  /** Stops the answer being written, for someone who talks over it. */
  stop(): void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How long nothing new must happen after an answer before it is read out. */
export const QUIET_AFTER_MS = 600

/**
 * How long a microphone may take to deliver sound before it counts as dead.
 * Nine seconds, from six: on the MacBook the earbuds' switch to headset
 * mode failed once and came back at 5.9s, twice in a row, and the next one
 * came back just after 6s - a working mic thrown away by a hair.
 */
export const LIVE_WAIT_MS = 9000

/**
 * After the "talk now" chime, before speech counts: the chime returns once
 * its last note is struck, but Bluetooth plays it a little later than that,
 * and its tail should not be taken for the first word.
 */
export const READY_TAIL_MS = 150

/**
 * On Linux, how long the earbuds' own mic may stay unlisted by PipeWire
 * before its word is not waited for (see watchMic). Longer than any switch
 * logged (5.9s), shorter than LIVE_WAIT_MS.
 */
export const UNLISTED_MS = 7000

/** A mic live sooner than this did not switch the earbuds, and one later gets ticks (see open()). */
export const NO_SWITCH_MS = 400

/**
 * How long a pause ends what you are saying. It was 1.3s, all of it spent
 * waiting after the last word before anything else could start, then a
 * second - longer than the gaps inside a sentence said at a normal pace, but
 * not than a pause to think: "sometimes when I just take a pause to think
 * through my mind for like 1 second, it just cuts it off... extend the pause
 * to... one and a half Mississippi." Half a second more of waiting at the
 * end of every question, for not being cut off in the middle of one.
 */
export const END_PAUSE_MS = 1500

/**
 * Nobody has said anything for this long since it last spoke: the
 * conversation ends by itself, with the same chord as a gesture ending it.
 */
export const IDLE_END_MS = 120_000

/**
 * Waiting for someone to start, the recording is begun afresh this often,
 * so a long wait is not a long clip - the gap between one and the next is
 * a few milliseconds. What does get sent is trimmed to PRE_ROLL_MS before
 * the first word anyway (see clipForSpeech).
 */
export const FRESH_EAR_MS = 20_000
export const PRE_ROLL_MS = 500

/**
 * Hearing starts at the first half second of quiet, not at the end of the
 * pause: what has been said so far goes to be transcribed while the rest
 * of END_PAUSE_MS is waited out, and if nothing more is said - the usual
 * case - the words are ready about a second sooner. Said more after all, and
 * that guess is dropped for one of the whole thing. "I don't like the delay."
 */
export const GUESS_AFTER_MS = 450
/** A guess still not back this long after the pause is over is given up for one of the whole clip. */
export const GUESS_WAIT_MS = 1500
/**
 * The pause that ends what is said, when the guess at it sounds like the
 * middle of a thought (see `unfinished`): long enough to finish the thought,
 * once, without everything waiting this long.
 */
export const UNFINISHED_PAUSE_MS = 3000

/**
 * Choosing out loud: the silence after the question that reads out the
 * options not read yet, and how many at a time - "give it a slight pause,
 * and then list out the rest of the models so that I know".
 */
export const MORE_AFTER_MS = 2500

/** Shorter than this and quieter than this many times the speech bar: not words (see listen). */
export const FAINT_MS = 300
export const FAINT_TIMES = 4
export const MORE_AT_ONCE = 5

/**
 * What starts speech in a conversation: three loud frames of four, about
 * 120ms. A single frame was enough for a turn that had just said "talk
 * now", but this mic is open all the time, and a tap on the earbud or a
 * click should not open an utterance. While anything plays into the
 * earbuds it takes more again: see STRICT_ONSET in the recorder.
 */
export const CONVERSATION_ONSET = { frames: 3, window: 4 }

/**
 * A second gesture this soon after the first is the same one. The earbuds
 * sometimes report a pinch twice, half a second apart (logged: 0.54s), and
 * the second used to cancel the turn the first had just started - which is
 * what "sometimes it works, sometimes it doesn't" looked like from outside.
 * Nobody means to end a conversation before they have said anything.
 */
export const SAME_GESTURE_MS = 1200

/**
 * The same, after a gesture that ended one: a report repeated this soon
 * is one gesture, and one after it is someone starting again. Shorter than
 * SAME_GESTURE_MS because nothing is being cut off here - and logged, a
 * deliberate second pinch came 1.09s after the one that stopped.
 */
export const REPORTED_TWICE_MS = 800

/**
 * Asked yes or no this many times with nobody saying anything at all, an
 * approval is left on the screen: in a conversation nobody has ended, it
 * would otherwise be asked every eight seconds until someone came back.
 */
export const UNANSWERED_ASKS = 4

/** Talking at least this long that comes back as no words is said to have been missed. */
export const MISSED_SENTENCE_MS = 900

/** After talking, how long quiet must last before the typing starts again. */
const TYPING_AGAIN_MS = 1500

/**
 * Windows names earbuds in headset mode "... Hands-Free AG Audio", for the
 * mic and for an output of their own, apart from the "Headphones" output
 * music plays on. With the mic open for a whole conversation, the answers
 * go to that one, or they can go nowhere. Elsewhere (Linux, or Windows with
 * one output per earbud) nothing is named so and the default is used.
 */
export async function handsFreeOutput(track: MediaStreamTrack | undefined): Promise<string | null> {
  if (!track || !/hands-?free/i.test(track.label)) return null
  try {
    const group = track.getSettings().groupId
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audiooutput' && /hands-?free/i.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications'
    )
    const name = /\(([^)]+)\)/.exec(track.label)?.[1]?.replace(/\s*hands-?free.*$/i, '').trim()
    const pick =
      outputs.find((d) => group && d.groupId === group) ?? outputs.find((d) => name && d.label.includes(name))
    return pick?.deviceId ?? null
  } catch {
    return null
  }
}

export function useVoiceTurn(deps: Deps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => {
    let busy = false
    let cancelled = false
    /** Ends the wait for a microphone to come on, when the conversation is ended. */
    let stopWaiting: () => void = () => {}
    let stopSound: (() => void) | null = null

    /** The conversation's microphone: opened once, and held until it ends. */
    let mic: MediaStream | null = null
    /** What is listening on it now. From "talk now" to the end there is always one. */
    let ear: Recording | null = null
    let earSince = 0
    /** The meter on the bar follows the mic only while it says "Listening". */
    let metering = false
    /**
     * PipeWire's word on the earbuds' mic (see main/btmic.ts): false while
     * they switch to headset mode or have dropped out of it. Always true
     * where there is nothing to ask.
     */
    let working = true
    let stopWatching: () => void = () => {}
    /** Sound is going to the earbuds, by PipeWire's account (see watchMic). */
    let earbudsOut = true
    /** The ticks that fill the wait for the mic are wanted now. */
    let waitingTicks = false
    /** The last wait for speech ran out with nobody talking. */
    let idled = false
    /** They talked over the answer: it stops, and what they say comes next. */
    let interrupted = false
    /**
     * The answer that was talked over, to carry on with if what was said
     * turns out not to be a question (see shared/interrupt.ts): since when,
     * its choice mark, and how many of its sentences had been heard.
     */
    let cut: { since: number; mark: number; heard: number } | null = null
    /** The answer being followed now, for `cut`. */
    let answerSince = 0
    let answerMark = 0
    /** Sentences of it skipped when it was carried on: the speaker counts from there. */
    let spokenBase = 0
    /** How the conversation ended, for the bar and the closing sound. */
    let ending: 'gesture' | 'idle' | 'failed' = 'gesture'

    /*
     * Every stage into wumpy.log, so a conversation that "did nothing" says
     * where it stopped: whether the mic opened and which one, how loud it
     * got, what was heard, whether Magpie spoke. It went quiet before, and
     * eight turns from the earbuds left eight identical lines and no way to
     * tell why.
     */
    const note = (line: string): void => window.wumpy.voice.log(`voice turn: ${line}`)
    const noteLine = note

    /** Speaks the answers' sentences as they come; replaced when talked over. */
    let speaker: Speaker | null = null
    const newSpeaker = (): Speaker => new Speaker({ onSound: stopTicks, note })
    /** Asking yes or no, or which one: talking then answers, it does not interrupt. */
    let asking = false
    /** How many sentences of each answer have been handed to the voice. */
    const fed = new Map<string, number>()
    /** Approvals nobody answered (see approveNow): left on the screen, not asked again. */
    const leftUnanswered = new WeakSet<object>()

    /** Plays a WAV in an audio element. False when it could not start. */
    function playElement(wav: ArrayBuffer, quick: boolean): Promise<boolean> {
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const audio = new Audio(url)
      audio.preservesPitch = true
      audio.playbackRate = quick ? Math.max(1.2, currentSpeed()) : currentSpeed()
      return new Promise<boolean>((resolve) => {
        let started = false
        const end = (ok: boolean): void => {
          stopSound = null
          URL.revokeObjectURL(url)
          resolve(ok)
        }
        stopSound = () => {
          audio.pause()
          end(true)
        }
        audio.onplaying = () => {
          started = true
          stopTicks()
        }
        audio.onended = () => end(true)
        audio.onerror = () => {
          note(`the speech could not be played: ${audio.error?.message || 'unknown error'}`)
          end(started)
        }
        void audio.play().catch((err) => {
          note(`the speech could not be played: ${String(err)}`)
          end(started)
        })
      })
    }

    /** The same WAV through Web Audio. False when it could not be decoded. */
    async function playWebAudio(wav: ArrayBuffer): Promise<boolean> {
      try {
        const context = new AudioContext()
        const buffer = await context.decodeAudioData(wav.slice(0))
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        await new Promise<void>((resolve) => {
          stopSound = () => {
            source.stop()
            resolve()
          }
          source.onended = () => resolve()
          stopTicks()
          source.start()
        })
        stopSound = null
        void context.close()
        return true
      } catch (err) {
        note(`Web Audio could not play the speech: ${String(err)}`)
        return false
      }
    }

    /**
     * Speaks, and returns once it has finished, so listening never hears it.
     * Streamed, sentence by sentence (see speaker.ts).
     *
     * Lists too, now. `quick` made them in one piece, to be played a fifth
     * faster by an audio element - and that was the "..." after every
     * command: "slash model" was 4.7s of typing and nothing said while 219
     * characters were made, "even though the AI is not even talking". The
     * speaker plays at the speed setting at the same pitch, which at the
     * default is as quick as `quick` was, and it starts in half a second.
     * The one-piece way is left for when there is no speaker.
     */
    async function say(text: string, quick = false): Promise<void> {
      if (!text || cancelled || interrupted) return
      showVoice({ stage: 'speaking', level: 0, detail: text.length > 160 ? `${text.slice(0, 157)}…` : text })
      if (speaker) {
        note(`speaking ${text.length} characters with Magpie, as it is made`)
        speaker.say(sentences(text))
        await speaker.drain()
        return
      }
      const wav = await window.wumpy.voice.speak(text).catch(() => null)
      if (cancelled) return
      note(`speaking ${text.length} characters with ${wav ? 'Magpie' : 'the system voice, since Magpie gave nothing'}`)
      /*
       * Magpie's answer never played, the first time a whole turn worked:
       * "Failed to load because no supported source was found." The WAV was
       * fine - the page's security policy had no media-src, so a blob: URL
       * fell under default-src 'self' and the audio element refused it. The
       * policy allows blob: audio now, and if the element refuses anyway,
       * the same WAV goes through Web Audio, which no media policy governs.
       * The ticks run until sound actually comes out, not until bytes
       * arrive.
       */
      if (wav) {
        if ((await playElement(wav, quick)) || cancelled) return
        note('playing it through Web Audio instead')
        if ((await playWebAudio(wav)) || cancelled) return
        note('Web Audio could not play it either; using the system voice')
      }
      stopTicks()
      // No NVIDIA voice: the system's own, where there is one.
      if ('speechSynthesis' in window) {
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.rate = quick ? Math.max(1.3, currentSpeed()) : currentSpeed()
          utterance.onend = () => resolve()
          utterance.onerror = () => resolve()
          stopSound = () => {
            speechSynthesis.cancel()
            resolve()
          }
          speechSynthesis.speak(utterance)
          // A machine with no speech engine never fires onend.
          setTimeout(resolve, Math.min(60_000, 2500 + text.length * 80))
        })
        stopSound = null
      }
    }

    /**
     * Hands every finished sentence of this turn's answers to the voice,
     * while they are still being written: the newest answer up to its last
     * full stop, and any answer that has finished, all of it. In order, and
     * each sentence once. Returns whether anything has been said this way.
     */
    function speakAhead(since: number): boolean {
      if (!speaker || cancelled || interrupted) return false
      const writing = depsRef.current.streaming()
      const answers = depsRef.current
        .messages()
        .filter((m) => m.createdAt >= since && m.role === 'assistant' && !m.local && !m.error)
      answers.forEach((m, i) => {
        const done = !(writing && i === answers.length - 1)
        const ready = readyToSay(m.content, done)
        const already = fed.get(m.id) ?? 0
        if (ready.length <= already) return
        const fresh = ready.slice(already)
        fed.set(m.id, ready.length)
        const shown = ready.join(' ')
        showVoice({ stage: 'speaking', level: 0, detail: shown.length > 160 ? `${shown.slice(0, 157)}…` : shown })
        if (already === 0) note(`speaking the answer as it is written${done ? '' : ', starting before it is finished'}`)
        speaker!.say(fresh)
      })
      return fed.size > 0
    }

    /*
     * PipeWire's word on the earbuds' mic, asked every 150ms while it comes
     * on and every second after, for dropouts. Twice running in a row before
     * it counts, since the source can be RUNNING a moment before sound
     * flows. Where the default mic is not Bluetooth, asked once.
     */
    function watchMic(): () => void {
      let on = true
      working = false
      const since = Date.now()
      let seen = false
      void (async () => {
        let runs = 0
        while (on) {
          const asked = await window.wumpy.voice.micState().catch(() => ({ mic: 'none' as const, earbudsOut: null }))
          const state = asked.mic
          if (!on) return
          /* The ticks only while sound goes to the earbuds: not from the
             laptop's speakers while the earbuds switch. */
          const out = asked.earbudsOut !== false
          if (out !== earbudsOut) {
            earbudsOut = out
            if (waitingTicks) out ? startTicks('waiting') : stopTicks()
          }
          if (state === 'none') {
            working = true
            return
          }
          /* Never listed at all, long after any switch should have shown it:
             this system names it some other way. Going by the sound alone,
             as before, beats a "talk now" that never comes. */
          if (state !== 'absent') seen = true
          if (!seen && Date.now() - since > UNLISTED_MS) {
            note('PipeWire never listed the earbuds’ own mic; going by the sound alone')
            working = true
            return
          }
          runs = state === 'running' ? runs + 1 : 0
          const was: boolean = working
          working = runs >= 2
          if (ear && was !== working) note(working ? 'the earbuds’ mic is back' : 'the earbuds’ mic dropped out')
          /* Quickly while it comes on; then once a second, for dropouts -
             digital silence is caught by the recorder itself at once. */
          await sleep(working ? 1000 : 150)
        }
      })()
      return () => {
        on = false
        working = true
        earbudsOut = true
      }
    }

    /**
     * A recording on the conversation's mic, listening for the next thing
     * said. Armed straight away, except the first, which waits for "talk
     * now". The next one is begun the moment one ends, so nothing said in
     * between - carrying on, or talking over the answer - is lost.
     */
    async function newEar(armed = true): Promise<Recording> {
      let self: Recording | null = null
      /* The room the last one measured, on this same mic (see Hearing.seed). */
      const room = ear ? ear.stats().room : 0
      const r = await record({
        stream: mic!,
        armed,
        room,
        silenceMs: END_PAUSE_MS,
        maxMs: 45_000,
        maxFromSpeech: true,
        onset: CONVERSATION_ONSET,
        gate: () => working,
        onLevel: (level) => {
          if (metering) showVoice({ level })
        },
        onSpeech: () => {
          if (self) heardSpeech(self)
        }
      })
      self = r
      ear = r
      earSince = Date.now()
      return r
    }

    /** Ends the ear that is listening, if nothing has been said in it, and begins the next. */
    async function nextEar(): Promise<Recording | null> {
      const old = ear
      if (!old || old.spoke()) return null
      old.stop()
      await newEar()
      return old
    }

    /*
     * Someone started talking. Over an answer, that is most likely someone
     * with something to say: it stops talking at once and listens. The
     * answer goes on being written until what they said is heard: a
     * question stops it then (see the conversation loop), and a cough or an
     * "mm-hm" lets it carry on from where it was cut. While it asks yes or
     * no, or which one, talking is the answer: the question stops being
     * read, and nothing else is cut short.
     */
    function heardSpeech(r: Recording): void {
      if (r !== ear || cancelled) return
      stopTicks()
      metering = true
      showVoice({ stage: 'listening', level: 0 })
      const talking = (speaker?.busy() ?? false) || stopSound !== null
      if (!talking && !(busy && !asking && answerSince && depsRef.current.streaming())) return
      const stats = r.stats()
      note(
        `talked over it: it stops and listens (before that the mic heard up to ${stats.strictPeak.toFixed(3)} ` +
          `while it spoke; talking over it takes ${strictBar(stats.bar).toFixed(3)})`
      )
      const heard = spokenBase + (speaker?.heard() ?? 0)
      stopSound?.()
      speaker?.stop()
      speaker = newSpeaker()
      if (asking) return
      interrupted = true
      if (!cut && answerSince) cut = { since: answerSince, mark: answerMark, heard }
    }

    /*
     * Opens the conversation: a dot, the microphone, ticking while it comes
     * on, then "talk now".
     *
     * The dot that says the hold was felt plays first, in the earbuds'
     * ordinary mode, where a chime is heard every time; then the mic opens,
     * which switches them to headset mode. "Talk now" waits until the mic
     * really delivers - "it said it's listening, but then it doesn't pick up
     * my microphone. And after like 5 seconds, then it picks up" was a
     * Bluetooth mic's hiss, taken for sound, so on Linux PipeWire must also
     * say the earbuds' mic is running (see watchMic) - and goes out through
     * a fresh output, opened after the switch, so there is nothing left from
     * before it to have broken.
     *
     * The ticks: "in between... can you add like some dots, like a regular
     * mechanical keyboard, tick, tick, tick" - the switch takes one to six
     * seconds, and silent it sounded like nothing was happening. They only
     * start if the mic is not on by NO_SWITCH_MS.
     */
    async function open(): Promise<boolean> {
      await chime('opening')
      if (cancelled) return false
      const opened = Date.now()
      stopWatching = watchMic()
      try {
        /* The system's default microphone: the earbuds', when they are
           connected. "I'm using the bud's mic." */
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
      } catch (err) {
        note(`the microphone could not be opened: ${String(err)}`)
        throw new Error(`The microphone could not be opened (${String(err)}).`)
      }
      const track = mic.getAudioTracks()[0]
      note(`microphone: ${track?.label || 'the system default'}`)
      /* The earbuds disconnected, or went back in their case: the mic is
         gone, and a conversation left listening to it would wait two
         minutes for nothing. */
      track?.addEventListener('ended', () => {
        if (!busy || cancelled || mic?.getAudioTracks()[0] !== track) return
        note('the microphone went away: the conversation ends')
        ending = 'failed'
        cancel()
        showVoice({ stage: 'error', level: 0, detail: 'The microphone went away - were the earbuds put back or disconnected?' })
      })
      const recording = await newEar(false)
      const slow = setTimeout(
        () => showVoice({ detail: 'Waiting for the earbuds’ microphone - Bluetooth is slow to switch it on…' }),
        1500
      )
      const waiting = setTimeout(() => {
        waitingTicks = true
        if (earbudsOut) startTicks('waiting')
      }, NO_SWITCH_MS)
      const stopped = new Promise<number>((resolve) => (stopWaiting = () => resolve(-2)))
      const liveMs = await Promise.race([recording.live, sleep(LIVE_WAIT_MS).then(() => -1), stopped])
      stopWaiting = () => {}
      clearTimeout(slow)
      clearTimeout(waiting)
      waitingTicks = false
      stopTicks()
      /* The earbuds switched under the output (or never came on): its
         stream may have broken with the switch, so "talk now" gets a fresh
         one. A mic live sooner than NO_SWITCH_MS switched nothing, and the
         output is kept: on the MacBook's own mic that saved 450ms. */
      if (liveMs < 0 || liveMs >= NO_SWITCH_MS) releaseOutput()
      if (cancelled) return false
      if (liveMs < 0) {
        note(`the microphone gave no sound for ${LIVE_WAIT_MS / 1000}s`)
        ending = 'failed'
        wakeOutput()
        await chime('cancel')
        showVoice({
          stage: 'error',
          level: 0,
          detail: 'The microphone never came on. Are the earbuds connected, and out of the case? Hold again to retry.'
        })
        return false
      }
      note(`microphone live after ${liveMs}ms`)
      const handsFree = await handsFreeOutput(track)
      if (handsFree) note('answers go to the earbuds’ hands-free output')
      playOn(handsFree)
      wakeOutput()
      await chime('listen')
      await sleep(READY_TAIL_MS)
      if (cancelled) return false
      recording.arm()
      metering = true
      note(`talk now: chimed and listening ${Date.now() - opened}ms after the mic was asked for`)
      showVoice({ stage: 'listening', level: 0, detail: 'Talk any time. Hold again to finish.' })
      return true
    }

    type Words = { heard: string; text: string; failed?: boolean }

    /** A clip, transcribed: as heard, and as tidied for sending. Empty for no words; `failed` when hearing it broke. */
    async function hearClip(blob: Blob, extension: string, onsetMs: number): Promise<Words> {
      try {
        const ready = await clipForSpeech(blob, extension, Math.max(0, onsetMs - PRE_ROLL_MS))
        const result = await window.wumpy.voice.transcribe(ready.audio, ready.extension, [])
        const heard = (result.heard || result.text || '').trim()
        return { heard, text: (result.text || heard).trim() }
      } catch (err) {
        note(`it could not be heard: ${String(err)}`)
        return { heard: '', text: '', failed: true }
      }
    }

    /**
     * The last thing said that came back as no words: how long the talking
     * was, and whether hearing it failed outright. In a conversation, saying
     * nothing back to a whole sentence sounds like it is still thinking.
     */
    let unheard: { talkedMs: number; failed: boolean } | null = null

    /*
     * The next thing said: waits up to `waitMs` for someone to start, then
     * until a pause of `pauseMs` ends it, and hears it. Null for silence,
     * which costs no request; `idled` says the wait ran out.
     *
     * If they carry on while it is being heard, it was not the end: the
     * rest is waited for and put after it, rather than sent as half a
     * question. "When I'm just speaking halfway through... it actually cuts
     * me off."
     */
    async function listen(pauseMs: number, waitMs: number, prompt = ''): Promise<{ text: string; heard: string } | null> {
      idled = false
      unheard = null
      if (cancelled || !ear) return null
      await speaker?.drain()
      if (cancelled || !ear) return null
      ear.setPause(pauseMs)
      metering = true
      if (!ear.spoke()) showVoice({ stage: 'listening', level: 0, detail: prompt })
      const since = Date.now()
      while (!cancelled && ear && !ear.spoke()) {
        if (Date.now() - since > waitMs) {
          idled = true
          return null
        }
        if (Date.now() - earSince > FRESH_EAR_MS) await nextEar()
        await sleep(60)
      }
      if (cancelled || !ear) return null
      /* What was heard, as said and as tidied for sending (commands, names). */
      let heardAll = ''
      let textAll = ''
      for (;;) {
        const r = ear
        /* Waiting out the pause, with a guess at the words from its first
           half second (see GUESS_AFTER_MS). */
        let guess: { at: number; words: Promise<Words | null> } | null = null
        const ending = r.done.then((clip) => ({ clip }))
        let clip: Awaited<typeof r.done>
        for (;;) {
          const ended = await Promise.race([ending, sleep(60).then(() => null)])
          if (ended) {
            clip = ended.clip
            break
          }
          if (r.quietMs() >= GUESS_AFTER_MS && guess?.at !== r.spokeAt()) {
            const at = r.spokeAt()
            const onset = r.onsetMs()
            guess = { at, words: r.snapshot().then((got) => (got ? hearClip(got.blob, got.extension, onset) : null)) }
            /* Trailing off mid-thought: a longer pause, this once. Back to
               the usual one if they carry on and it sounds finished then. */
            const heardSoFar = heardAll
            void guess.words.then((w) => {
              if (r !== ear || r.spokeAt() !== at || !w?.heard) return
              const mid = unfinished(heardSoFar ? `${heardSoFar} ${w.heard}` : w.heard)
              if (mid && pauseMs < UNFINISHED_PAUSE_MS) {
                r.setPause(UNFINISHED_PAUSE_MS)
                note(`it sounds unfinished ("...${w.heard.slice(-30)}"): waiting ${UNFINISHED_PAUSE_MS / 1000}s for the rest`)
              } else r.setPause(pauseMs)
            })
          }
        }
        const endedAt = Date.now()
        /* Talking, not counting the wait before it or the pause after. */
        const talkedMs = clip ? clip.ms - r.onsetMs() - r.quietMs() : 0
        metering = false
        await newEar()
        if (cancelled) return null
        const stats = r.stats()
        note(
          `heard ${clip ? `${(Math.max(0, talkedMs) / 1000).toFixed(1)}s of talking` : 'nothing worth sending'}, ` +
            `loudest ${stats.peak.toFixed(3)} (speech counts from ${stats.bar.toFixed(3)})` +
            `${stats.dropMs ? `; the mic dropped out for ${stats.dropMs}ms of it` : ''}`
        )
        /* A blip barely over the room - a click, a breath - is not words,
           and Whisper makes words of it: "Bye." from 0.1s peaking at 0.004,
           with speech counting from 0.002 and their voice reaching 0.2. */
        const faint = Boolean(clip) && talkedMs < FAINT_MS && stats.peak < stats.bar * FAINT_TIMES
        if (faint) note(`too short and faint to be words (${Math.max(0, talkedMs)}ms, loudest ${stats.peak.toFixed(3)}): not sent`)
        if (clip && !faint) {
          showVoice({ stage: 'hearing', level: 0 })
          /* The typing is "got it": no chime for it. */
          startTicks()
          /* The guess is good if nothing was said after it was taken, and
             it heard words; otherwise the whole clip is heard now. */
          const guessed =
            guess && guess.at === r.spokeAt() ? await Promise.race([guess.words, sleep(GUESS_WAIT_MS).then(() => null)]) : null
          const words = guessed?.heard ? guessed : await hearClip(clip.blob, clip.extension, r.onsetMs())
          note(
            words.heard
              ? /* Whole, or near it: cut at 120, "heard 36.5s of talking" could
                   not show whether the end of it got through. */
                `heard "${words.heard.length > 600 ? `${words.heard.slice(0, 597)}...` : words.heard}" (${words.heard.split(/\s+/).length} words) ` +
                `${Date.now() - endedAt}ms after the pause${guessed?.heard ? ', from the guess' : ''}`
              : 'the transcriber returned no words'
          )
          if (words.heard) {
            heardAll = heardAll ? `${heardAll} ${words.heard}` : words.heard
            textAll = textAll ? `${textAll} ${words.text}` : words.text
          } else {
            unheard = { talkedMs: Math.max(0, talkedMs), failed: Boolean(words.failed) }
          }
        }
        if (cancelled) return null
        if (!ear?.spoke()) break
        stopTicks()
        note('they carried on talking: waiting for the rest')
      }
      if (!heardAll) stopTicks()
      if (heardAll) unheard = null
      return heardAll ? { text: textAll, heard: heardAll } : null
    }
    /** Asks about whatever is waiting, until it is answered yes or no. */
    async function approve(): Promise<void> {
      asking = true
      try {
        await approveNow()
      } finally {
        asking = false
      }
    }
    async function approveNow(): Promise<void> {
      let asked = false
      let unanswered = 0
      for (;;) {
        const entry = newestPending()
        if (!entry || cancelled || leftUnanswered.has(entry)) return
        /* Nobody answering at all: they have walked away. It stays on the
           screen, unrun, rather than being asked every eight seconds for as
           long as the conversation lasts. */
        if (unanswered >= UNANSWERED_ASKS) {
          leftUnanswered.add(entry)
          note(`no answer to "${approvalQuestion(entry)}" after ${UNANSWERED_ASKS} asks: left on the screen`)
          await say('I’ll leave that on the screen.')
          return
        }
        await say(asked ? 'Yes or no?' : `${approvalQuestion(entry)} Say yes or no.`)
        asked = true
        if (cancelled || newestPending() !== entry) continue
        const answer = await listen(900, 8000, 'Say yes or no.')
        unanswered = idled ? unanswered + 1 : 0
        // Clicked in the panel while it was listening: that is an answer too.
        if (newestPending() !== entry) continue
        const said = answer ? yesNo(answer.heard) : null
        if (said === 'yes') {
          entry.run()
          /* Said, not chimed: the chord now means the conversation is over. */
          await say('Okay.')
          return
        }
        if (said === 'no') {
          entry.skip()
          await say('Okay, I won’t.')
          return
        }
        // Silence or anything that is not yes or no: ignored, asked again.
      }
    }

    /**
     * A question on screen, out loud: read it, listen, and answer it.
     *
     * Returns 'left' when it was not answered - cancelled, or three tries
     * that matched nothing - so the turn does not ask it again. It stays on
     * screen either way, for a click.
     */
    async function answerChoice(entry: { seq: number; choice: AloudChoice }): Promise<'answered' | 'left'> {
      asking = true
      try {
        return await answerChoiceNow(entry)
      } finally {
        asking = false
      }
    }
    async function answerChoiceNow(entry: {
      seq: number
      choice: AloudChoice
    }): Promise<'answered' | 'left'> {
      const { choice } = entry
      const all = choice.options
      const byId = (id: string): AloudOption | undefined => all.find((o) => o.id === id)
      const names = (list: AloudOption[]): Array<{ id: string; names: string[] }> =>
        list.map((o) => ({ id: o.id, names: [o.label, ...(o.names ?? [])] }))
      const open = (): boolean => !cancelled && stillWaiting(entry.seq)

      /* Yes or no, and nothing else answers it - the same rule as an
         approval, for the same reason: what follows a yes cannot be undone. */
      if (choice.confirm) {
        let asked = false
        while (open()) {
          await say(asked ? 'Yes or no?' : `${choice.question} Say yes or no.`)
          asked = true
          if (!open()) break
          const heard = await listen(900, 8000)
          if (!open()) break
          const said = heard ? yesNo(heard.heard) : null
          if (said) {
            choice.choose(all[said === 'yes' ? 0 : 1].id)
            return 'answered'
          }
        }
        return 'answered'
      }

      let numbered = (choice.numbered ?? all.map((o) => o.id))
        .map(byId)
        .filter((o): o is AloudOption => Boolean(o))
      /* Every option can be picked by name, but only the first few are
         read - "I can only select the models that are top 5, which is
         really annoying" - when nobody knows what the others are called.
         So a short silence after the question reads the rest, a few at a
         time and numbered on from the first ones, until one is said. */
      let unread = all.filter((o) => !numbered.includes(o))
      let toldOthers = false
      let narrowed: AloudOption[] | null = null
      let prompt = choice.intro
        ? `${choice.intro} ${choice.question}`
        : `${choice.question} ${spokenList(all.map((o) => sayModel(o.label)))}?`
      let quick = true
      let misses = 0
      while (open()) {
        await say(prompt, quick)
        if (!open()) break
        const reading = unread.length > 0 && !narrowed
        const heard = await listen(1100, reading ? MORE_AFTER_MS : 8000)
        if (!open()) break
        if (!heard && reading && idled) {
          const next = unread.slice(0, MORE_AT_ONCE)
          unread = unread.slice(next.length)
          const from = numbered.length
          numbered = [...numbered, ...next]
          prompt =
            `${toldOthers ? '' : 'The others: '}` +
            `${numberedSpeech(next.map((o) => sayModel(o.label)), MORE_AT_ONCE, from)}` +
            `${unread.length ? '' : ' Which one?'}`
          toldOthers = true
          quick = true
          continue
        }
        const said = heard?.heard ?? ''
        /* "Slash model" said while the list was read was taken for a name -
           one slip from "flash" - and chose GLM 5.3 Flash. A command is
           not an answer: it leaves the question on the screen and runs. */
        const command = said ? spokenCommand(said, commandNames(), false) : null
        if (command?.sure) {
          note(`"${said.slice(0, 60)}" is ${command.command}: the question is left for it`)
          depsRef.current.send(command.command)
          return 'left'
        }
        /* The model's own "Shall I?" with Yes and No buttons: "no" is an
           answer to that, not a way out of it. */
        const word = said ? yesNo(said) : null
        const plain = word ? all.find((o) => yesNo(o.label) === word) : undefined
        if (plain) {
          choice.choose(plain.id)
          return 'answered'
        }
        if (said && (isCancel(said) || word === 'no')) {
          await say('Okay, leaving it.')
          return 'left'
        }
        const place = said ? placeIn(said, numbered.length) : null
        if (place !== null) {
          choice.choose(numbered[place].id)
          return 'answered'
        }
        /* "The smartest one", "most intelligent model", "best overall",
           "the quickest": the top of that ranking, which answers to the
           ranking's own word. With a name - "the fastest Nemotron" - both
           are matched together. */
        const ranked = said ? orderingIn(said) : null
        if (ranked && !ranked.rest) {
          const top = all.find((o) => o.names?.includes(ORDER_NAME[ranked.ordering]))
          if (top) {
            choice.choose(top.id)
            return 'answered'
          }
        }
        const asked = ranked ? `${ORDER_NAME[ranked.ordering]} ${ranked.rest}` : said
        let hits: string[] = said ? matchSpoken(asked, names(narrowed ?? all)) : []
        if (!hits.length && narrowed && said) hits = matchSpoken(asked, names(all))
        if (hits.length === 1) {
          choice.choose(hits[0])
          return 'answered'
        }
        if (hits.length > 1) {
          /* "Nemotron": all of them, in the order they were ranked. */
          const fits = hits.map(byId).filter((o): o is AloudOption => Boolean(o))
          narrowed = fits
          numbered = fits
          prompt = `${fits.length} of them. ${numberedSpeech(
            fits.map((o) => sayModel(o.label))
          )} Which one?`
          quick = true
          continue
        }
        /* Asked for by name, and not something that can be picked. */
        const gone = said && choice.unavailable?.length
          ? matchSpoken(said, choice.unavailable.map((u, i) => ({ id: String(i), names: u.names })))
          : []
        if (gone.length === 1) {
          prompt = `${choice.unavailable![Number(gone[0])].why} Pick another, or say cancel.`
          quick = false
          continue
        }
        misses++
        if (misses >= 3) {
          await say('I’ll leave it on the screen.')
          return 'left'
        }
        prompt = `Sorry, which one? Say a name or a number, or say cancel.`
        quick = false
      }
      return 'answered'
    }

    /**
     * Until the turn is over: nothing streaming, nothing waiting for an
     * answer, no approved command still running - and staying that way for a
     * moment, since a finished command hands its output back to the model a
     * beat after it ends. On the way it says what commands did, and answers
     * whatever is asked on screen.
     */
    async function settle(mark: number, since: number): Promise<boolean> {
      const deadline = Date.now() + 20 * 60_000
      let quietSince = 0
      let talked = false
      const left = new Set<number>()
      while (!cancelled && !interrupted && Date.now() < deadline) {
        speakAhead(since)
        const told = takeTold()
        if (told.length) {
          await say(told.join(' '))
          talked = true
          quietSince = 0
          continue
        }
        const waitingOn = newestPending()
        if (waitingOn && !leftUnanswered.has(waitingOn)) {
          await approve()
          talked = true
          quietSince = 0
          continue
        }
        const asking = newestChoice(mark, since)
        if (asking && !left.has(asking.seq)) {
          if ((await answerChoice(asking)) === 'left') left.add(asking.seq)
          talked = true
          quietSince = 0
          continue
        }
        if (depsRef.current.streaming() || runningCount() > 0) {
          quietSince = 0
          /* Typing while nothing is being said; not between two sentences
             of an answer that is still coming. */
          if (!speaker?.busy() && (speaker?.idleFor() ?? Infinity) > TYPING_AGAIN_MS) startTicks()
          await sleep(120)
          continue
        }
        if (!quietSince) quietSince = Date.now()
        /* Long enough for a card the answer put up to register (a frame or
           two), and no longer: it was 1.8s, measured as the single biggest
           wait between the answer arriving and hearing it. */
        if (Date.now() - quietSince > QUIET_AFTER_MS) return talked
        await sleep(150)
      }
      return talked
    }

    /** "Slash log?" - yes, no, or whatever else was said instead. */
    async function confirmCommand(name: string): Promise<'yes' | 'no' | { text: string; heard: string } | null> {
      asking = true
      try {
        await say(`Slash ${name}?`)
        if (cancelled) return null
        const reply = await listen(900, 8000, 'Say yes or no.')
        if (!reply) return null
        return yesNo(reply.heard) ?? reply
      } finally {
        asking = false
      }
    }

    /** Sends what was said, and stays with it until it has all been answered. */
    async function answer(heard: { text: string; heard: string }): Promise<void> {
      /* An answer still being written to what came before - talked over,
         and this is the next question - stops here, or this would wait. */
      if (depsRef.current.streaming()) depsRef.current.stop()
      /* "Slash love", "slash the leak": a command misheard is asked about,
         not run and not sent to the model as words. Yes runs it; anything
         else they say instead is what they meant. */
      const spoken = spokenCommand(heard.heard, commandNames())
      if (spoken && !spoken.sure) {
        note(`"${heard.heard.slice(0, 60)}" sounds like ${spoken.command}: asking`)
        const reply = await confirmCommand(spoken.name)
        if (cancelled) return
        if (reply && typeof reply === 'object') return answer(reply)
        if (reply !== 'yes') {
          await say('Okay.')
          return
        }
      }
      showVoice({ stage: 'thinking', heard: heard.heard, detail: '' })
      /* By time, not by position: a chat opened by this turn replaces the
         transcript, and its old answers are not this turn's to read. */
      const started = Date.now()
      const mark = choiceMark()
      answerSince = started
      answerMark = mark
      /* "Switch to the smartest model", with no slash: the model it means. */
      const slash = spoken?.command ?? spokenSlash(heard.heard) ?? modelSwitchIn(heard.heard, MODEL_NAMES)
      /* No chime for "sent": "there's no need for that." The typing that
         started at "got it" runs on, unbroken, until the answer starts. */
      depsRef.current.send(slash ?? heard.text)
      await follow(started, mark)
    }

    /** This turn's answers so far, in order. */
    function answersSince(since: number): ChatMessage[] {
      return depsRef.current
        .messages()
        .filter((m) => m.createdAt >= since && m.role === 'assistant' && !m.local && !m.error)
    }

    /**
     * Stays with an answer until it has all been said: from the start, or -
     * carrying on after a cough was taken for talking over it - from the
     * first sentence not heard to the end.
     */
    async function follow(started: number, mark: number, skip = 0): Promise<void> {
      spokenBase = skip
      if (skip) {
        const writing = depsRef.current.streaming()
        const answers = answersSince(started)
        let left = skip
        answers.forEach((m, i) => {
          const ready = readyToSay(m.content, !(writing && i === answers.length - 1)).length
          const n = Math.min(left, ready)
          fed.set(m.id, n)
          left -= n
        })
      } else {
        for (const m of answersSince(started)) fed.delete(m.id)
      }
      const talked = await settle(mark, started)
      if (cancelled || interrupted) return
      /* Whatever is left of the answers, now that they are finished. */
      const spokeAnswer = speakAhead(started)
      const since = depsRef.current.messages().filter((m) => m.createdAt >= started)
      /* A command's own note ("Reflection on.") when there was no answer and
         nothing else was said - otherwise there would be nothing at all. */
      const told = talked || spokeAnswer
        ? undefined
        : [...since].reverse().find((m) => m.role === 'assistant' && m.local && m.content.trim())
      /* The model failed: said so, rather than leaving a silence that
         sounds like it is still thinking. */
      const failed = talked || spokeAnswer || told
        ? undefined
        : [...since].reverse().find((m) => m.role === 'assistant' && m.error)
      if (spokeAnswer) await speaker?.drain()
      else if (told) await say(speakable(told.content, 300))
      else if (failed) {
        noteLine(`the answer failed: ${String(failed.error).slice(0, 160)}`)
        await say('Sorry, I couldn’t get an answer just then. Try asking again?')
      } else {
        stopTicks()
        noteLine(talked ? 'nothing more to say' : 'no answer came back to read out')
      }
      const stats = ear?.stats()
      if (!cancelled && !interrupted && stats && stats.strictPeak > 0)
        note(`while it spoke the mic heard up to ${stats.strictPeak.toFixed(3)}; talking over it takes ${strictBar(stats.bar).toFixed(3)}`)
    }

    async function conversation(): Promise<void> {
      const status = await window.wumpy.voice.start()
      if (status.kind !== 'ready') {
        noteLine(`speech is not ready (${status.kind})`)
        ending = 'failed'
        await say('Voice needs an NVIDIA key, or the local transcriber installed.')
        showVoice({ stage: 'error', detail: 'Voice needs an NVIDIA key, or the local transcriber installed.' })
        return
      }
      if (!(await open())) return
      /* Stricter about what counts as talking while anything is playing
         into the earbuds next to the mic: a chime, the typing, an answer. */
      const strictness = setInterval(() => {
        ear?.strict(ticking() || (speaker?.busy() ?? false) || stopSound !== null)
      }, 50)
      /* A lead-in on its own, waiting for what it leads into. */
      let held: { text: string; heard: string } | null = null
      try {
        while (!cancelled) {
          interrupted = false
          const heard = await listen(END_PAUSE_MS, IDLE_END_MS, 'Talk any time. Hold again to finish.')
          if (cancelled) return
          if (idled) {
            note(`nothing said for ${IDLE_END_MS / 60_000} minutes: the conversation ends`)
            ending = 'idle'
            return
          }
          /* Talked over an answer: what was it? */
          if (cut) {
            const was = cut
            cut = null
            const kind = heard ? interruption(heard.heard) : 'nothing'
            if (kind === 'nothing') {
              note(`${heard ? `"${heard.heard}"` : 'that'} was not a question: carrying on with the answer`)
              interrupted = false
              await follow(was.since, was.mark, was.heard)
              continue
            }
            if (depsRef.current.streaming()) depsRef.current.stop()
            if (kind === 'stop') {
              note(`told to ${heard?.heard.toLowerCase().replace(/[^a-z' ]/g, '').trim()}: it stops, and listens`)
              stopTicks()
              showVoice({ stage: 'listening', level: 0, detail: 'Talk any time. Hold again to finish.' })
              continue
            }
          }
          if (!heard) {
            /* A sentence's worth of talking with no words back, or hearing
               that broke: said so, briefly. A cough or a word's worth of
               noise is left alone. */
            const missed = unheard as { talkedMs: number; failed: boolean } | null
            if (missed && (missed.failed || missed.talkedMs >= MISSED_SENTENCE_MS)) {
              note(missed.failed ? 'hearing it failed: said so' : 'a whole sentence came back as no words: said so')
              await say(missed.failed ? 'Sorry, I couldn’t hear that just now. Say it again?' : 'Sorry, I didn’t catch that.')
            }
            showVoice({ stage: 'listening', level: 0, detail: 'Talk any time. Hold again to finish.' })
            continue
          }
          /* "Okay. Also," - a breath before the question: held for it. */
          if (leadInOnly(heard.heard)) {
            note(`"${heard.heard}" is only the start of something: holding it for the rest`)
            held = held ? { text: `${held.text} ${heard.text}`, heard: `${held.heard} ${heard.heard}` } : heard
            showVoice({ stage: 'listening', level: 0, detail: 'Go on.' })
            continue
          }
          const whole = held ? { text: `${held.text} ${heard.text}`, heard: `${held.heard} ${heard.heard}` } : heard
          held = null
          await answer(whole)
        }
      } finally {
        clearInterval(strictness)
      }
    }

    /** Lets go of the microphone, so the earbuds go back to their ordinary mode. */
    async function closeMic(): Promise<void> {
      stopWatching()
      stopWatching = () => {}
      const last = ear
      ear = null
      metering = false
      last?.stop()
      for (const t of mic?.getTracks() ?? []) t.stop()
      mic = null
      if (last) await last.done
    }

    /* A gesture, or Stop on the bar: ends the conversation where it is. */
    const cancel = (): void => {
      if (!busy) return
      cancelled = true
      stopTicks()
      stopWaiting()
      stopSound?.()
      speaker?.stop()
      ear?.stop()
      /* An answer still being written is left to finish on screen: ending
         the conversation stops it being read, not written. */
      note('ended')
      showVoice({ stage: 'cancelled', level: 0 })
    }
    setVoiceStopper(cancel)

    let startedAt = 0
    /** A gesture came while it was ending: open a new one once this has. */
    let again = false

    const begin = (): void => {
      busy = true
      cancelled = false
      interrupted = false
      cut = null
      answerSince = 0
      spokenBase = 0
      ending = 'gesture'
      startedAt = Date.now()
      fed.clear()
      /* "Can you make him speak a little bit faster?" See stretch.ts. */
      void window.wumpy.settings.get().then((s) => setSpeed(s.speakRate ?? 1)).catch(() => {})
      playOn(null)
      wakeOutput()
      speaker = newSpeaker()
      note('started')
      showVoice({ stage: 'starting', level: 0, heard: '', detail: '' })
      setHandsFree(true)
      /* Music off while the conversation lasts, back on after. */
      void window.wumpy.music.hold()
      void conversation()
        .catch((err) => {
          const why = err instanceof Error ? err.message : String(err)
          ending = 'failed'
          note(`failed: ${why}`)
          showVoice({ stage: 'error', level: 0, detail: why })
        })
        .then(async () => {
          stopTicks()
          speaker?.stop()
          speaker = null
          /* The chord that says it is over, through the earbuds' headset
             link while it is still up - closing the mic switches them back,
             and a sound in the middle of that switch can be lost. */
          if (ending !== 'failed') await chime('done')
          await closeMic()
          /* A gesture's end said so already (see cancel); after two quiet
             minutes or a failure, it is said here, once the mic is let go. */
          if (!cancelled) note('ended')
          if (ending !== 'failed')
            showVoice({
              stage: 'done',
              level: 0,
              detail: ending === 'idle' ? 'Finished - nobody spoke for a while.' : 'Finished.'
            })
        })
        .finally(() => {
          releaseOutput()
          playOn(null)
          busy = false
          setHandsFree(false)
          void window.wumpy.music.release()
          if (again) {
            again = false
            begin()
          }
        })
    }

    /**
     * Hold to start, hold again to finish. Talking interrupts, so the
     * gesture no longer has to.
     */
    let lastGesture = 0
    const off = window.wumpy.voice.onTurn(() => {
      const now = Date.now()
      if (!busy) {
        lastGesture = now
        begin()
        return
      }
      const after = Math.min(now - startedAt, now - lastGesture)
      if (now - startedAt < SAME_GESTURE_MS || now - lastGesture < REPORTED_TWICE_MS) {
        note(`a second gesture ${after}ms after the last, taken as the same one`)
        return
      }
      lastGesture = now
      /* Already ending, from the gesture before: this one is starting
         again, as soon as the last has wound down. */
      if (cancelled) {
        note('held again while it was ending: starting again once it has')
        again = true
        return
      }
      note(`held again ${((now - startedAt) / 1000).toFixed(0)}s in: the conversation ends`)
      cancel()
    })
    return () => {
      off()
      setVoiceStopper(() => {})
    }
  }, [])
}

import { useEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/types'
import { approvalQuestion, speakable, spokenSlash, yesNo } from '@shared/spoken'
import {
  isCancel,
  matchSpoken,
  numberedSpeech,
  placeIn,
  sayModel,
  spokenList
} from '@shared/spokenpick'
import { SPEECH_LEVEL, record } from '../recorder'
import { clipForSpeech } from '../wav'
import { newestPending, pendingCount, runningCount } from '../pending'
import { setHandsFree, takeTold } from '../handsfree'
import { choiceMark, newestChoice, stillWaiting, type AloudChoice, type AloudOption } from '../aloud'
import { setVoiceStopper, showVoice, voiceView } from '../voiceview'
import { chosenMic } from '../mic'
import { chime, releaseOutput, startTicks, stopTicks, wakeOutput } from '../earcons'
import { Speaker } from '../speaker'
import { readyToSay, sentences } from '@shared/speakahead'

/**
 * A spoken turn, run from the hidden panel: `wumpy --voice` (a gesture on the
 * earbuds, through Nothing X) or the tray.
 *
 * It listens, hears with Parakeet (Whisper without a key), hands the words to
 * the same place typing goes - so "slash remember ..." is the /remember
 * command and everything else is a message - and then stays with the turn
 * until it is really over: through every command the model proposes, each
 * one asked about out loud, and any command still running. The final answer
 * is read aloud; code never is.
 *
 * An approval cannot be skipped by staying quiet. The question is asked again
 * until the answer is yes or no, and anything else said is ignored - a reply
 * like "yes, but first..." must not run anything. Clicking the card in the
 * panel answers it too. Triggering a voice turn again cancels this one.
 *
 * A question Wumpy asks on screen - which model, which chat, delete it or
 * keep it, or the model's own question - is read out and answered the same
 * way: by name, roughly ("Nemotron super"), or by place ("the second one").
 * A name that fits several gets those several read back, best first. Lists
 * are read a little faster than answers, since they are for skimming.
 *
 * Music playing on the machine is paused for the length of the turn and
 * picked up again after (see main/music.ts).
 */
interface Deps {
  /** The composer's send: commands, intents and messages all go through it. */
  send(text: string): void
  streaming(): boolean
  messages(): ChatMessage[]
  /** Stops the answer being written, for a gesture that interrupts it. */
  stop(): void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How long nothing new must happen after an answer before it is read out. */
export const QUIET_AFTER_MS = 600

/** How long a microphone may take to deliver sound before it counts as dead. */
export const LIVE_WAIT_MS = 6000

/**
 * How long a pause ends what you are saying. It was 1.3s, all of it spent
 * waiting after the last word before anything else could start; a second
 * is still longer than the gaps inside a sentence said at a normal pace.
 */
export const END_PAUSE_MS = 1000

/**
 * A second gesture this soon after the first is the same one. The earbuds
 * sometimes report a pinch twice, half a second apart (logged: 0.54s), and
 * the second used to cancel the turn the first had just started - which is
 * what "sometimes it works, sometimes it doesn't" looked like from outside.
 * Nobody means to cancel a question before they have had time to ask it.
 */
export const SAME_GESTURE_MS = 1200

/** After talking, how long quiet must last before the typing starts again. */
const TYPING_AGAIN_MS = 1500

export function useVoiceTurn(deps: Deps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => {
    let busy = false
    let cancelled = false
    let stopListening: (() => void) | null = null
    let stopSound: (() => void) | null = null
    /** The loudest the mic got in the last listen, to say WHY nothing was heard. */
    let lastPeak = 0
    /** The last listen's mic never delivered sound at all. */
    let micDead = false
    let micNamed = false

    /*
     * Every stage into wumpy.log, so a turn that "did nothing" says where it
     * stopped: whether the mic opened and which one, how loud it got, what
     * was heard, whether Magpie spoke. It went quiet before, and eight turns
     * from the earbuds left eight identical lines and no way to tell why.
     */
    const note = (line: string): void => window.wumpy.voice.log(`voice turn: ${line}`)
    const noteLine = note

    /*
     * The typing sound while it works (see earcons.ts): from the moment it
     * has your words until it speaks or asks you something. Stopped by
     * anything that makes a sound or opens the mic, so the mic never hears
     * it and it never talks over an answer.
     */
    /** Speaks this turn's sentences as they come; replaced each turn. */
    let speaker: Speaker | null = null
    /** Asking yes or no, or which one: a gesture then cancels, never interrupts. */
    let asking = false
    /** How many sentences of each answer have been handed to the voice. */
    const fed = new Map<string, number>()

    /** Plays a WAV in an audio element. False when it could not start. */
    function playElement(wav: ArrayBuffer, quick: boolean): Promise<boolean> {
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const audio = new Audio(url)
      audio.preservesPitch = true
      audio.playbackRate = quick ? 1.2 : 1
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
     * Streamed, sentence by sentence (see speaker.ts). `quick` is for lists:
     * a fifth faster at the same pitch, which only an audio element can do,
     * so those are made in one piece and played the old way.
     */
    async function say(text: string, quick = false): Promise<void> {
      if (!text || cancelled) return
      showVoice({ stage: 'speaking', level: 0, detail: text.length > 160 ? `${text.slice(0, 157)}…` : text })
      if (!quick && speaker) {
        note(`speaking ${text.length} characters with Magpie, as it is made`)
        speaker.say(sentences(text))
        await speaker.drain()
        return
      }
      await speaker?.drain()
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
          utterance.rate = quick ? 1.3 : 1
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
      if (!speaker || cancelled) return false
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

    /**
     * One utterance: waits up to `waitMs` for speech to start, then until a
     * pause of `pauseMs` ends it. Null for silence, which costs no request.
     */
    async function listen(
      pauseMs: number,
      waitMs: number,
      maxMs: number,
      prompt = ''
    ): Promise<{ text: string; heard: string } | null> {
      if (cancelled) return null
      await speaker?.drain()
      if (cancelled) return null
      let spoke = false
      let peak = 0
      let armed = false
      micDead = false
      stopTicks()
      showVoice({ stage: 'starting', level: 0, detail: prompt })
      const opened = Date.now()
      const mic = await chosenMic()
      if (!micNamed) {
        micNamed = true
        note(`microphone: ${mic.label} - ${mic.why}`)
      }
      let recording: Awaited<ReturnType<typeof record>>
      try {
        recording = await record({
          deviceId: mic.deviceId,
          armed: false,
          silenceMs: pauseMs,
          maxMs,
          onLevel: (level, rms) => {
            showVoice({ level })
            if (!armed) return
            if (rms >= SPEECH_LEVEL) spoke = true
            if (rms > peak) peak = rms
          }
        })
      } catch (err) {
        note(`the microphone could not be opened: ${String(err)}`)
        throw new Error(`The microphone could not be opened (${String(err)}).`)
      }
      stopListening = () => recording.stop()

      /*
       * The chime means "I can hear you now", so it waits until that is
       * true. It used to play first and the mic opened after, and with the
       * earbuds' mic that was a Bluetooth switch to headset mode - seconds
       * of exact silence, sometimes a failure - with the person already
       * talking into it.
       */
      const liveMs = await Promise.race([recording.live, sleep(LIVE_WAIT_MS).then(() => -1)])
      if (cancelled) {
        recording.stop()
        await recording.done
        return null
      }
      if (liveMs < 0) {
        note(`the microphone gave no sound for ${LIVE_WAIT_MS / 1000}s`)
        micDead = true
        lastPeak = 0
        recording.stop()
        await recording.done
        stopListening = null
        return null
      }
      note(`microphone live after ${liveMs}ms`)
      await chime('listen')
      if (cancelled) {
        recording.stop()
        await recording.done
        return null
      }
      armed = true
      recording.arm()
      showVoice({ stage: 'listening', level: 0, detail: prompt })

      const giveUp = setTimeout(() => {
        if (!spoke) recording.stop()
      }, waitMs)
      const clip = await recording.done
      clearTimeout(giveUp)
      stopListening = null
      lastPeak = peak
      note(
        `listened ${((Date.now() - opened) / 1000).toFixed(1)}s, loudest ${peak.toFixed(3)} ` +
          `(speech counts from ${SPEECH_LEVEL}), ${clip ? 'kept the recording' : 'nothing worth sending'}`
      )
      if (!clip || cancelled) return null
      showVoice({ stage: 'hearing', level: 0 })
      /* "Got it" the moment it stops recording, while the words are already
         on their way to be transcribed - the chime costs no time. */
      const transcribing = clipForSpeech(clip.blob, clip.extension).then((ready) =>
        window.wumpy.voice.transcribe(ready.audio, ready.extension, [])
      )
      transcribing.catch(() => {}) // thrown again below, where it is awaited
      await chime('heard')
      startTicks()
      const result = await transcribing
      const heard = (result.heard || result.text || '').trim()
      note(heard ? `heard "${heard.slice(0, 120)}"` : 'the transcriber returned no words')
      return heard ? { text: (result.text || heard).trim(), heard } : null
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
      for (;;) {
        const entry = newestPending()
        if (!entry || cancelled) return
        await say(asked ? 'Yes or no?' : `${approvalQuestion(entry)} Say yes or no.`)
        asked = true
        if (cancelled || newestPending() !== entry) continue
        const answer = await listen(900, 8000, 10_000, 'Say yes or no.')
        // Clicked in the panel while it was listening: that is an answer too.
        if (newestPending() !== entry) continue
        const said = answer ? yesNo(answer.heard) : null
        if (said === 'yes') {
          entry.run()
          await chime('done')
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
          const heard = await listen(900, 8000, 10_000)
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
      let narrowed: AloudOption[] | null = null
      let prompt = choice.intro
        ? `${choice.intro} ${choice.question}`
        : `${choice.question} ${spokenList(all.map((o) => sayModel(o.label)))}?`
      let quick = true
      let misses = 0
      while (open()) {
        await say(prompt, quick)
        if (!open()) break
        const heard = await listen(1100, 8000, 15_000)
        if (!open()) break
        const said = heard?.heard ?? ''
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
        let hits: string[] = said ? matchSpoken(said, names(narrowed ?? all)) : []
        if (!hits.length && narrowed && said) hits = matchSpoken(said, names(all))
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
      while (!cancelled && Date.now() < deadline) {
        speakAhead(since)
        const told = takeTold()
        if (told.length) {
          await say(told.join(' '))
          talked = true
          quietSince = 0
          continue
        }
        if (pendingCount() > 0) {
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

    async function turn(): Promise<void> {
      const status = await window.wumpy.voice.start()
      if (status.kind !== 'ready') {
        noteLine(`speech is not ready (${status.kind})`)
        await say('Voice needs an NVIDIA key, or the local transcriber installed.')
        showVoice({ stage: 'error', detail: 'Voice needs an NVIDIA key, or the local transcriber installed.' })
        return
      }
      const heard = await listen(END_PAUSE_MS, 8000, 45_000)
      if (!heard) {
        if (cancelled) return
        await chime('cancel')
        showVoice({
          stage: 'nothing',
          detail: micDead
            ? 'The microphone gave no sound at all. /microphone shows which one is in use.'
            : lastPeak < SPEECH_LEVEL
              ? 'The microphone stayed quiet. Is the right one selected, and not muted?'
              : 'It heard sound but no words. Try again, a little closer.'
        })
        return
      }
      showVoice({ stage: 'thinking', heard: heard.heard, detail: '' })
      /* By time, not by position: a chat opened by this turn replaces the
         transcript, and its old answers are not this turn's to read. */
      const started = Date.now()
      const mark = choiceMark()
      const slash = spokenSlash(heard.heard)
      depsRef.current.send(slash ?? heard.text)
      /* And "sent": the words have gone to the AI, and the typing that
         follows is it working on them. */
      await chime('sent')
      await sleep(150)
      const talked = await settle(mark, started)
      if (cancelled) return
      /* Whatever is left of the answers, now that they are finished. */
      const spokeAnswer = speakAhead(started)
      const since = depsRef.current.messages().filter((m) => m.createdAt >= started)
      const answer = [...since]
        .reverse()
        .find((m) => m.role === 'assistant' && !m.local && m.content.trim() && !m.error)
      /* A command's own note ("Reflection on.") when there was no answer and
         nothing else was said - otherwise the turn ends in a bare chime. */
      const note = talked || spokeAnswer
        ? undefined
        : [...since].reverse().find((m) => m.role === 'assistant' && m.local && m.content.trim())
      const text = answer ? speakable(answer.content) : note ? speakable(note.content, 300) : ''
      if (spokeAnswer) await speaker?.drain()
      else if (note) await say(text)
      else {
        noteLine(talked ? 'nothing more to say' : 'no answer came back to read out')
        await chime('done')
      }
      /* The answer stays on the bar after it is said, for a glance. */
      if (!cancelled) showVoice({ stage: 'done', detail: text.length > 160 ? `${text.slice(0, 157)}…` : text })
    }

    /* A second gesture, or Stop on the bar: ends the turn where it is. */
    const cancel = (): void => {
      if (!busy) return
      cancelled = true
      stopTicks()
      stopListening?.()
      stopSound?.()
      speaker?.stop()
      note('stopped')
      showVoice({ stage: 'cancelled', level: 0 })
    }
    setVoiceStopper(cancel)

    let startedAt = 0
    /** A gesture came while it was answering: listen again once this ends. */
    let again = false

    const begin = (): void => {
      busy = true
      cancelled = false
      micNamed = false
      startedAt = Date.now()
      fed.clear()
      wakeOutput()
      speaker = new Speaker({ onSound: stopTicks, note })
      note('started')
      showVoice({ stage: 'starting', level: 0, heard: '', detail: '' })
      setHandsFree(true)
      /* Music off while it listens and talks, back on after. */
      void window.wumpy.music.hold()
      void turn()
        .catch((err) => {
          const why = err instanceof Error ? err.message : String(err)
          note(`failed: ${why}`)
          showVoice({ stage: 'error', level: 0, detail: why })
        })
        .finally(() => {
          stopTicks()
          speaker?.stop()
          speaker = null
          releaseOutput()
          busy = false
          setHandsFree(false)
          void window.wumpy.music.release()
          if (again) {
            again = false
            begin()
          }
        })
    }

    const off = window.wumpy.voice.onTurn(() => {
      if (!busy) {
        begin()
        return
      }
      const after = Date.now() - startedAt
      if (after < SAME_GESTURE_MS) {
        note(`a second gesture ${after}ms after the first, taken as the same one`)
        return
      }
      /*
       * Pinched while it is answering: that is someone with something to
       * say, as when you talk over a person - so it stops, and listens.
       * The answer being written stops too, or the new question could not
       * be sent until it finished. While it is listening, or asking yes or
       * no, a pinch still just cancels.
       */
      const stage = voiceView().stage
      if (!asking && (stage === 'speaking' || stage === 'thinking')) {
        note('interrupted: listening again')
        again = true
        if (depsRef.current.streaming()) depsRef.current.stop()
      }
      cancel()
    })
    return () => {
      off()
      setVoiceStopper(() => {})
    }
  }, [])
}

import { useEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/types'
import { approvalQuestion, speakable, spokenSlash, yesNo } from '@shared/spoken'
import { SPEECH_LEVEL, record } from '../recorder'
import { clipForSpeech } from '../wav'
import { newestPending, pendingCount, runningCount } from '../pending'
import { setHandsFree } from '../handsfree'

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
 */
interface Deps {
  /** The composer's send: commands, intents and messages all go through it. */
  send(text: string): void
  streaming(): boolean
  messages(): ChatMessage[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function useVoiceTurn(deps: Deps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => {
    let busy = false
    let cancelled = false
    let stopListening: (() => void) | null = null
    let stopSound: (() => void) | null = null

    /** Short tones, so the earbuds say what is happening without words. */
    async function chime(kind: 'listen' | 'done' | 'cancel'): Promise<void> {
      const notes = kind === 'listen' ? [660, 990] : kind === 'done' ? [990, 660] : [300, 220]
      try {
        const context = new AudioContext()
        const step = 0.11
        notes.forEach((hz, i) => {
          const osc = context.createOscillator()
          const gain = context.createGain()
          osc.type = 'sine'
          osc.frequency.value = hz
          const at = context.currentTime + i * step
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + step)
          osc.connect(gain).connect(context.destination)
          osc.start(at)
          osc.stop(at + step)
        })
        await sleep(notes.length * step * 1000 + 60)
        void context.close()
      } catch {
        /* no sound device: the turn goes on without its cue */
      }
    }

    /** Speaks, and returns once it has finished, so listening never hears it. */
    async function say(text: string): Promise<void> {
      if (!text || cancelled) return
      const wav = await window.wumpy.voice.speak(text).catch(() => null)
      if (cancelled) return
      if (wav) {
        const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
        const audio = new Audio(url)
        await new Promise<void>((resolve) => {
          stopSound = () => {
            audio.pause()
            resolve()
          }
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          void audio.play().catch(() => resolve())
        })
        stopSound = null
        URL.revokeObjectURL(url)
        return
      }
      // No NVIDIA voice: the system's own, where there is one.
      if ('speechSynthesis' in window) {
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text)
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
     * One utterance: waits up to `waitMs` for speech to start, then until a
     * pause of `pauseMs` ends it. Null for silence, which costs no request.
     */
    async function listen(
      pauseMs: number,
      waitMs: number,
      maxMs: number
    ): Promise<{ text: string; heard: string } | null> {
      if (cancelled) return null
      let spoke = false
      const recording = await record({
        silenceMs: pauseMs,
        maxMs,
        onLevel: (_level, rms) => {
          if (rms >= SPEECH_LEVEL) spoke = true
        }
      })
      stopListening = () => recording.stop()
      const giveUp = setTimeout(() => {
        if (!spoke) recording.stop()
      }, waitMs)
      const clip = await recording.done
      clearTimeout(giveUp)
      stopListening = null
      if (!clip || cancelled) return null
      const ready = await clipForSpeech(clip.blob, clip.extension)
      const result = await window.wumpy.voice.transcribe(ready.audio, ready.extension, [])
      const heard = (result.heard || result.text || '').trim()
      return heard ? { text: (result.text || heard).trim(), heard } : null
    }

    /** Asks about whatever is waiting, until it is answered yes or no. */
    async function approve(): Promise<void> {
      let asked = false
      for (;;) {
        const entry = newestPending()
        if (!entry || cancelled) return
        await say(asked ? 'Yes or no?' : `${approvalQuestion(entry)} Say yes or no.`)
        asked = true
        if (cancelled || newestPending() !== entry) continue
        await chime('listen')
        const answer = await listen(900, 8000, 10_000)
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
     * Until the turn is over: nothing streaming, nothing waiting for an
     * answer, no approved command still running - and staying that way for a
     * moment, since a finished command hands its output back to the model a
     * beat after it ends.
     */
    async function settle(): Promise<void> {
      const deadline = Date.now() + 20 * 60_000
      let quietSince = 0
      while (!cancelled && Date.now() < deadline) {
        if (pendingCount() > 0) {
          await approve()
          quietSince = 0
          continue
        }
        if (depsRef.current.streaming() || runningCount() > 0) {
          quietSince = 0
          await sleep(200)
          continue
        }
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince > 1800) return
        await sleep(150)
      }
    }

    async function turn(): Promise<void> {
      const status = await window.wumpy.voice.start()
      if (status.kind !== 'ready') {
        await say('Voice needs an NVIDIA key, or the local transcriber installed.')
        return
      }
      await chime('listen')
      const heard = await listen(1300, 8000, 45_000)
      if (!heard) {
        await chime('cancel')
        return
      }
      const before = depsRef.current.messages().length
      const slash = spokenSlash(heard.heard)
      depsRef.current.send(slash ?? heard.text)
      await sleep(300)
      await settle()
      if (cancelled) return
      const answer = depsRef.current
        .messages()
        .slice(before)
        .reverse()
        .find((m) => m.role === 'assistant' && m.content.trim() && !m.error)
      const text = answer ? speakable(answer.content) : ''
      if (text) await say(text)
      else await chime('done')
    }

    return window.wumpy.voice.onTurn(() => {
      if (busy) {
        cancelled = true
        stopListening?.()
        stopSound?.()
        return
      }
      busy = true
      cancelled = false
      setHandsFree(true)
      void turn()
        .catch((err) => console.warn('[wumpy] voice turn failed:', err))
        .finally(() => {
          busy = false
          setHandsFree(false)
        })
    })
  }, [])
}

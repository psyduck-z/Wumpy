import { useSyncExternalStore } from 'react'

/**
 * What a voice turn is doing, for the bar that shows it.
 *
 * Asked for in these words: "make the process something I can see, not a
 * background process." A turn from the earbuds used to run in a hidden
 * window and say nothing on screen, so when it heard nothing there was
 * nothing to look at - not whether the mic opened, not what it caught, not
 * where it stopped. Now the window comes up and this says, as it happens.
 *
 * A store of its own rather than React state in App: the level changes
 * twenty-five times a second while listening, and that should redraw one
 * small bar, not the whole conversation.
 */
export type VoiceStage =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'speaking'
  | 'done'
  | 'nothing'
  | 'cancelled'
  | 'error'

export interface VoiceView {
  stage: VoiceStage
  /** 0..1 while listening. */
  level: number
  /** What it heard, once it has. */
  heard: string
  /** The question being asked, what is being said, or what went wrong. */
  detail: string
}

const IDLE: VoiceView = { stage: 'idle', level: 0, heard: '', detail: '' }
let view: VoiceView = IDLE
const listeners = new Set<() => void>()
let clear: ReturnType<typeof setTimeout> | undefined

/** The stages a turn ends on, which fade after a few seconds. */
export const FINISHED: ReadonlySet<VoiceStage> = new Set(['done', 'nothing', 'cancelled', 'error'])

export function showVoice(next: Partial<VoiceView>): void {
  view = { ...view, ...next }
  clearTimeout(clear)
  if (FINISHED.has(view.stage)) {
    clear = setTimeout(() => showVoice({ ...IDLE }), view.stage === 'error' ? 15_000 : 6000)
  }
  for (const l of listeners) l()
}

export function voiceView(): VoiceView {
  return view
}

export function useVoiceView(): VoiceView {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => view
  )
}

/* The bar's Stop button: the same as a second gesture, set by the turn. */
let stopper: () => void = () => {}
export function setVoiceStopper(fn: () => void): void {
  stopper = fn
}
export function stopVoice(): void {
  stopper()
}

/**
 * Acting on the screen: the steps the model may propose, and nothing else.
 *
 * Asked for after a refusal the user did not accept: "My Gmail tab is
 * literally open. I'm giving it permission to do it... I asked it to navigate
 * to my Gmail tab, which is open right now, and click compose, and then send
 * to someone called Stanley."
 *
 * The refusal was honest at the time - Wumpy could look at the screen and
 * could not touch it - so the fix is the capability, not a prompt that tells
 * the model to claim one it lacks. This is the vocabulary for the touching.
 *
 * Coordinates are in the SCREENSHOT's pixels, not the screen's. The model
 * knows where things are because it just looked at an image, and that image
 * was scaled down on the way out; asking it to undo that scaling in its head
 * is asking for a click in the wrong place. Main translates, because main is
 * the only side that knows which display was photographed and by how much it
 * shrank.
 *
 * Pure and shared, so the whole grammar can be checked without a desktop.
 */

const NL = String.fromCharCode(10)

export type Step =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right'; times: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; chord: string }
  | { kind: 'wait'; ms: number }

export interface Plan {
  /** The `# why` line, for the card. */
  reason: string
  steps: Step[]
  /** Lines that are not steps at all, so the card can say what was ignored. */
  problems: string[]
}

/**
 * A ceiling on one block, because a runaway plan is the failure mode here.
 *
 * Twelve is more than any real sequence - open a tab, click a field, type,
 * press enter is four - and small enough that a model which has started
 * generating clicks in a loop is stopped by the parser rather than by the
 * user watching their desktop being driven.
 */
export const MAX_STEPS = 12

/** Long enough for an address or a sentence; not a document. */
export const MAX_TYPE = 500

/** A pause the user can sit through. Anything longer is a hang. */
export const MAX_WAIT = 5000

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}

/**
 * Reads a plan, keeping what is valid and naming what is not.
 *
 * It never throws and never returns a step it could not fully understand. A
 * half-read `click` with one coordinate is dropped and reported, because a
 * click at a guessed coordinate is worse than no click.
 */
export function readPlan(raw: string): Plan {
  const reason: string[] = []
  const steps: Step[] = []
  const problems: string[] = []

  for (const line of raw.split(NL)) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('#')) {
      reason.push(text.replace(/^#+\s*/, '').trim())
      continue
    }
    if (steps.length >= MAX_STEPS) {
      problems.push(`more than ${MAX_STEPS} steps; the rest were dropped`)
      break
    }

    const space = text.indexOf(' ')
    const verb = (space < 0 ? text : text.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : text.slice(space + 1).trim()

    if (verb === 'click' || verb === 'rightclick' || verb === 'doubleclick' || verb === 'move') {
      const pair = /^(-?\d+)[\s,]+(-?\d+)$/.exec(rest)
      if (!pair) {
        problems.push(`${verb} needs two numbers: ${text}`)
        continue
      }
      const x = Number(pair[1])
      const y = Number(pair[2])
      if (x < 0 || y < 0) {
        problems.push(`${verb} has a negative coordinate: ${text}`)
        continue
      }
      if (verb === 'move') steps.push({ kind: 'move', x, y })
      else
        steps.push({
          kind: 'click',
          x,
          y,
          button: verb === 'rightclick' ? 'right' : 'left',
          times: verb === 'doubleclick' ? 2 : 1
        })
      continue
    }

    if (verb === 'type') {
      /* Not trimmed beyond the line's own edges: a trailing space in a typed
         string is sometimes the point, and leading indentation never is. */
      if (!rest) {
        problems.push(`type has nothing to type: ${text}`)
        continue
      }
      if (rest.length > MAX_TYPE) {
        problems.push(`type is longer than ${MAX_TYPE} characters; dropped`)
        continue
      }
      steps.push({ kind: 'type', text: rest })
      continue
    }

    if (verb === 'key') {
      if (!/^[a-z0-9+\s]+$/i.test(rest) || !rest) {
        problems.push(`key needs a chord like ctrl+a: ${text}`)
        continue
      }
      steps.push({ kind: 'key', chord: rest.replace(/\s+/g, '') })
      continue
    }

    if (verb === 'wait') {
      const ms = Number(rest)
      if (!Number.isFinite(ms) || ms <= 0) {
        problems.push(`wait needs a number of milliseconds: ${text}`)
        continue
      }
      steps.push({ kind: 'wait', ms: clamp(Math.round(ms), 1, MAX_WAIT) })
      continue
    }

    problems.push(`not a step: ${text}`)
  }

  return { reason: reason.join(' ').trim(), steps, problems }
}

/** One line per step, for the card. What is about to happen to their desktop. */
export function describe(step: Step): string {
  switch (step.kind) {
    case 'click':
      return `${step.times > 1 ? 'Double-click' : step.button === 'right' ? 'Right-click' : 'Click'} at ${step.x}, ${step.y}`
    case 'move':
      return `Move the pointer to ${step.x}, ${step.y}`
    case 'type':
      return `Type ${JSON.stringify(step.text)}`
    case 'key':
      return `Press ${step.chord}`
    case 'wait':
      return `Wait ${step.ms}ms`
  }
}

/**
 * Where a screenshot pixel is on the real screen.
 *
 * The capture is of one display, taken at that display's size in device-
 * independent pixels and then scaled down to fit the long edge. So going back
 * is: undo the shrink, then add the display's own origin - which is not zero
 * on a second monitor, and is the step whose absence puts every click on the
 * wrong screen.
 */
export interface ShotFrame {
  /** The display's work origin and size, in the coordinates SetCursorPos takes. */
  displayX: number
  displayY: number
  displayWidth: number
  displayHeight: number
  /** The image the model was actually shown. */
  imageWidth: number
  imageHeight: number
}

export function toScreen(frame: ShotFrame, x: number, y: number): { x: number; y: number } {
  const kx = frame.displayWidth / frame.imageWidth
  const ky = frame.displayHeight / frame.imageHeight
  return {
    x: Math.round(frame.displayX + x * kx),
    y: Math.round(frame.displayY + y * ky)
  }
}

/** True when the point is inside the image the model was shown. */
export function onShot(frame: ShotFrame, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight
}

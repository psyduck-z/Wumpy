/**
 * What Wumpy has actually done, recorded by Wumpy.
 *
 * Asked whether it had opened Spotify, the model said "I did not open
 * Spotify. I checked whether it is installed." It said it twice more after
 * being told it was wrong, and only admitted it when told to re-read its own
 * command. The output of that command said LAUNCHED.
 *
 * Rules in the prompt were the first answer to that and they are not enough,
 * because they ask the model to be honest about its own memory of its own
 * intent - and its memory was that the command was "the installed-check",
 * which is what the prompt had called it. It was not lying so much as reading
 * the label instead of the receipt.
 *
 * So the app keeps the receipt. Every command run, file written and link
 * opened is recorded here as it happens, by the code that did it, and goes
 * into the facts block every turn. The model is then not being asked to
 * remember whether it acted; it is being told, by the thing that acted.
 *
 * This matters most for the case the user raised: a script that runs once and
 * does something that cannot be undone. "I didn't run anything" about one of
 * those is the worst sentence this app could produce, and the only real
 * defence is that the app, not the model, decides what that sentence says.
 *
 * Kept outside React for the same reason once.ts is: a ref dies with the
 * component instance, and this has to survive a remount.
 */

export type ActionKind = 'command' | 'write' | 'open' | 'search'

export interface Action {
  kind: ActionKind
  /** Short, and the real thing - the command, the path, the host. */
  what: string
  at: number
}

const actions: Action[] = []

/** Longest a recorded detail may be. The facts block is paid for every turn. */
const MAX_DETAIL = 120

export function record(kind: ActionKind, what: string): void {
  const detail = what.trim().replace(/\s+/g, ' ')
  actions.push({
    kind,
    what: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail,
    at: Date.now()
  })
}

export function actionsSoFar(): readonly Action[] {
  return actions
}

/**
 * Cleared when the conversation is, so a new chat starts with a clean sheet
 * and a reopened one does not claim to have done things in this session that
 * it did in another.
 */
export function forgetActions(): void {
  actions.length = 0
}

/**
 * The lines that go in the facts block.
 *
 * Empty when nothing has happened, so an ordinary conversation pays nothing
 * for this. Once something has, it is stated flatly and the most recent one
 * is named, because "did you just do X" is always about the last thing.
 */
export function actionFacts(): string[] {
  if (!actions.length) return []

  const counts = new Map<ActionKind, number>()
  for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)

  const noun: Record<ActionKind, [string, string]> = {
    command: ['command', 'commands'],
    write: ['file', 'files'],
    open: ['link', 'links'],
    search: ['search', 'searches']
  }
  const verb: Record<ActionKind, string> = {
    command: 'run',
    write: 'written',
    open: 'opened',
    search: 'run'
  }

  const parts: string[] = []
  for (const [kind, n] of counts) {
    const [one, many] = noun[kind]
    parts.push(`${n} ${n === 1 ? one : many} ${verb[kind]}`)
  }

  const last = actions[actions.length - 1]
  return [
    `- In this chat you have already: ${parts.join(', ')}.`,
    `- The most recent was: ${last.what}`,
    '- These happened. If the user asks whether you did something on this list,',
    '  the answer is yes. Do not deny it.'
  ]
}

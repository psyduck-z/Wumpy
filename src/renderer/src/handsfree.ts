/**
 * Whether the conversation is happening through the earbuds right now.
 *
 * A voice turn (wumpy --voice, from a gesture on the buds) sets this for as
 * long as it lasts: the spoken question, every command it asks about out
 * loud, and the output handed back after each one. Every request sent in
 * that time says so (ChatRequest.context.handsFree), and the model is told
 * the person is listening, not reading - so it answers in a sentence or two
 * of plain speech instead of a table nobody will see. Typing in the window,
 * or holding the spacebar to dictate, is not hands-free: the person is at
 * the screen.
 */
let active = false

export function setHandsFree(on: boolean): void {
  active = on
  if (!on) told.length = 0
}

export function handsFree(): boolean {
  return active
}

/*
 * Things to say out loud that are not an answer.
 *
 * "Deleted Fish pie", "Now on Nemotron Super": what a command did, which on
 * screen is a toast or a note and through the earbuds would otherwise be
 * nothing at all. The voice turn says each one as it arrives. Outside a
 * voice turn there is nobody listening and these are dropped.
 */
const told: string[] = []

export function tell(text: string): void {
  if (active && text.trim()) told.push(text.trim())
}

/** Everything told since last asked, oldest first. */
export function takeTold(): string[] {
  return told.splice(0, told.length)
}

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
}

export function handsFree(): boolean {
  return active
}

/**
 * The stop time the user gave, and whether it has come.
 *
 * Outside React for the same reason as the hold-to-talk machine: useChat's
 * send reads it at the moment a hand-back tries to go out, and a value
 * captured in a render could be a stop time that has since passed.
 *
 * `halted` is the time having come. From then until the user says something,
 * nothing goes to the model on its own - not a command's output, not an
 * agent's report - because that is what "do not continue past 10:30" means.
 * Anything they type or say starts things again.
 */
let at: number | null = null
let halted = false

export const deadline = {
  get: (): number | null => at,
  set: (next: number | null): void => {
    at = next
  },
  halted: (): boolean => halted,
  halt: (value: boolean): void => {
    halted = value
  }
}

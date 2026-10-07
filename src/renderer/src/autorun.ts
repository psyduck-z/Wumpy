/**
 * What an automatic approval mode is allowed to run without a person present.
 *
 * This is deliberately a plain function with no React in it, because the two
 * bugs it exists to prevent were both invisible:
 *
 *  - the run cap was computed in the app and then never passed down, so the
 *    "6 commands have run without you" note appeared while the cards carried
 *    on running;
 *  - nothing stopped the same command running twice, and a small model handed
 *    "exit code 0, no output" very often replies by proposing it again, which
 *    in an automatic mode is a loop that runs as fast as the model can type.
 *
 * Whether the command has finished streaming is decided by the card, and
 * whether the message came from this session is decided by the app; both are
 * about where the text came from rather than what it is.
 */

/** Unattended runs allowed between one typed message and the next. */
export const AUTO_RUN_LIMIT = 6

export interface AutoRunState {
  /** The command as it would be run, before trimming. */
  command: string
  /** Commands already run since the user last typed. */
  ranCommands: string[]
  /** How many have run unattended since the user last typed. */
  autoRuns: number
}

export function autoRunEligible({ command, ranCommands, autoRuns }: AutoRunState): boolean {
  if (autoRuns >= AUTO_RUN_LIMIT) return false
  // Whitespace is not the difference between two commands.
  const normalised = command.trim()
  if (!normalised) return false
  return !ranCommands.some((c) => c.trim() === normalised)
}

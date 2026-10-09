import type { ShellResult } from './types'

/**
 * Whether a command failed before it ran at all.
 *
 * There is a real difference between "the check ran and found nothing" and
 * "the check never ran", and getting it wrong produced the worst answer this
 * app has given: asked whether Spotify was installed, the model proposed a
 * check, the check failed to parse, and it reported that Spotify was not
 * installed - then said it was certain. Spotify was in the Start menu.
 *
 * The prompt now forbids that inference, but the prompt was not the only
 * thing pushing it. Wumpy's own report ended every finished command with
 * "Answer the original question from this output, in words", which on a
 * syntax error is an instruction to conclude something from an error message.
 * The app was asking for the mistake and then the model was blamed for it.
 *
 * PowerShell says ParserError in the CategoryInfo of anything it could not
 * parse, and the specific failures seen here - a wrapped command losing its
 * line continuation - come back as MissingExpression or a missing-argument
 * complaint. Matched together with empty output, because a command that
 * printed something did run far enough to tell you something.
 */
const PARSE_FAILURE =
  /ParserError|MissingExpression|Missing expression|Missing an argument|Unexpected token|is not recognized as the name of a cmdlet/i

export function neverRan(result: Pick<ShellResult, 'stdout' | 'stderr' | 'exitCode'>): boolean {
  if (result.exitCode === 0) return false
  if (result.stdout.trim()) return false
  return PARSE_FAILURE.test(result.stderr)
}

/**
 * What to tell the model about a command that never ran.
 *
 * The opposite of the ordinary ending in two ways that both matter. It must
 * not answer the question from this, because there is nothing here to answer
 * it with; and it SHOULD propose the command again, where a command that ran
 * must not be repeated. Re-proposing a fixed command is the whole remedy.
 */
export const NEVER_RAN_ENDING = [
  'That command did NOT run. PowerShell could not parse it, so it never',
  'reached the system and it has told you NOTHING about the question.',
  'This is not a negative result and not an answer.',
  'The usual cause is a command wrapped onto two lines: a bare line break',
  'ends a statement in PowerShell, so the rest runs as fragments. Send it',
  'again as ONE line.',
  'Do not answer the original question from this output.'
]

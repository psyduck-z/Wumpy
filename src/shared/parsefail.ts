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

/**
 * What to tell the model about a command that ran and failed.
 *
 * Asked to open Spotify, the model proposed Start-Process "Spotify", which
 * fails because the app is not on PATH - and then concluded "Spotify is not
 * installed", two messages after it had correctly established that Spotify
 * IS installed. One failed command overturned a fact it had already proved.
 *
 * The ordinary ending was pushing that, the same way it pushed the parse-error
 * mistake: "Do not propose it again. Answer the original question from this
 * output." For a command that failed, the second sentence asks for a
 * conclusion the output cannot support, and the first reads as "stop", when
 * the right move is to try a different way of doing the same thing.
 *
 * So this says both halves out loud: not the same command again, but do not
 * give up either, and do not contradict yourself. Bounded by the unattended
 * run cap, which is what stops "try again" becoming a loop.
 */
export const FAILED_ENDING = [
  'That command ran and FAILED. It did not do what was asked.',
  'Do not send the SAME command again — but do not give up either. If there',
  'is another way to do what the user actually wanted, propose it now, as',
  'ONE command.',
  'A failure here is about this command, not about the world: it does not',
  'prove the thing is missing, absent or impossible. Never contradict',
  'something you already established earlier in this conversation because a',
  'command failed.',
  'Only say it cannot be done once you have actually tried another way, and',
  'then say plainly what you tried and what it said.'
]

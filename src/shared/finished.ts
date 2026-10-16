/**
 * Saying it is done, in the same message that proposes doing it.
 *
 * Reported three times now, most recently as "it still falsely claims that
 * it's finished when it's not, like still, when it's still running like a
 * code". The shape is always the same: a wumpy-run block, and then a
 * sentence after it saying the thing has happened.
 *
 * It cannot have. The words after a block are written before the block has
 * run - the model emits the whole message in one pass - and on accept-all
 * the command starts the moment the message lands, so the claim is on
 * screen while the installer is still going.
 *
 * The prompt says this at length: "AND NEVER SAY IT IS DONE IN THE SAME
 * BREATH AS PROPOSING IT ... Anything after the block is future tense."
 * That paragraph has been there for some time and the reports kept coming,
 * which is the usual sign that a request is being used where a check is
 * needed. A prompt asks the model not to; this notices when it did.
 *
 * Shared, for the same reason normaliseFences is. The grader for this lived
 * in bench-ceiling alone, so the benchmark could fail a model for a claim
 * the app would then show the user without comment - measuring a Wumpy that
 * does not exist. One implementation, used by both.
 */

const FENCE = String.fromCharCode(96).repeat(3)
const NL = String.fromCharCode(10)

/**
 * The prose, with fenced blocks removed.
 *
 * A reply trips on the `# why` comment of the very command that proves it
 * did NOT believe the install - "# check whether Spotify is installed" -
 * so the blocks come out before anything is read.
 */
export function stripBlocks(text: string): string {
  return text
    .split(FENCE)
    .filter((_, i) => i % 2 === 0)
    .join(' ')
}

/** Words that make "is installed" a thing being looked into, not asserted. */
const HEDGED =
  /\b(check|checking|confirm|confirming|verify|verifying|whether|if|whether or not|make sure|see)\b/i

/**
 * The flat assertion that the job is over.
 *
 * "you can now" and "good to go" are here because the first version knew
 * only the word "installed", and the claim simply moved: the install was
 * proposed and the message went on to say it was ready to use. A completion
 * claim wearing a different hat is the same claim.
 */
const FINISHED_CLAIM =
  /(is|has been|was|’s|'s) (now )?installed|ready to (use|go)|successfully installed|all set|you can now|good to go|that'?s (it|done)|done!/i

/** Whether this prose ASSERTS that the job finished, sentence by sentence. */
export function claimsFinished(text: string): boolean {
  return stripBlocks(text)
    .split(/(?<=[.!?])\s+|\n/)
    .some((sentence) => FINISHED_CLAIM.test(sentence) && !HEDGED.test(sentence))
}

/** The fenced kinds that DO something, as opposed to showing something. */
const ACTS = /^\s*```wumpy-(run|run-cmd|run-bash|do|write)\b/

/**
 * Whether a message proposes an action, and then claims it is finished.
 *
 * Only the prose AFTER the first acting block counts, and that is the whole
 * precision of this. A message may legitimately open by reporting what the
 * LAST command found - "Spotify is installed, so I will check the version"
 * - and that sentence is true, about output already seen. What cannot be
 * true is a completion claim written after a block that has not run, which
 * is also exactly the rule the prompt states.
 *
 * Returns false for a message with no acting block at all: a plain answer
 * saying "you can now open it" is reporting, not predicting.
 */
export function claimsBeforeRunning(text: string): boolean {
  const lines = text.split(NL)
  const at = lines.findIndex((line) => ACTS.test(line))
  if (at === -1) return false
  return claimsFinished(lines.slice(at).join(NL))
}

/**
 * What the transcript says underneath such a message.
 *
 * Deliberately about the block rather than about the model: the user needs
 * to know the sentence they just read is not yet true, and does not need a
 * lecture about whose fault that is.
 */
export const NOT_YET_LINE =
  'That says it is done — but the command above has not finished. Whatever it claims, ' +
  'the result is whatever the output says.'

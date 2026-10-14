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

/**
 * Whether PowerShell could not find the program the command asked for.
 *
 * This had been lumped in with parse failures, and the consequence was a
 * loop. Asked for the docker version, the model proposed `docker --version`;
 * PowerShell answered CommandNotFoundException; Wumpy told the model the
 * command had NOT run, had said NOTHING about the question, and should be
 * sent again as one line - so it proposed `docker --version` again, and
 * would have forever. Meanwhile the real answer was sitting in the error:
 * there is no docker on this machine.
 *
 * The two cases are told apart by WHICH term was not recognised. A command
 * wrapped onto two lines leaves a fragment behind, and the fragment is not
 * the command's head - that is the captured case
 * `-ErrorAction : The term '-ErrorAction' is not recognized`. When the
 * unrecognised term IS the head, nothing was mangled: the program is absent.
 */
export function notOnPath(result: { stderr: string; command?: string }): boolean {
  const named = /The term ['"]([^'"]+)['"] is not recognized/i.exec(result.stderr)
  if (!named) return false
  const head = (result.command ?? '').trim().split(/\s+/)[0]
  if (!head) return false
  const bare = head.replace(/^['"]|['"]$/g, '').toLowerCase()
  return named[1].toLowerCase() === bare
}

export function neverRan(
  result: Pick<ShellResult, 'stdout' | 'stderr' | 'exitCode'> & { command?: string }
): boolean {
  if (result.exitCode === 0) return false
  if (result.stdout.trim()) return false
  // An absent program is a real result, not a command that failed to parse.
  if (notOnPath({ stderr: result.stderr, command: result.command })) return false
  return PARSE_FAILURE.test(result.stderr)
}

/**
 * What to tell the model when the program simply is not there.
 *
 * It must NOT re-propose the command, because the command is fine and the
 * machine is the answer. And it must not overreach either: a terminal tool
 * missing from PATH is settled, but an APPLICATION can be installed and
 * still not be on PATH, which is a different question with a different
 * check.
 */
/**
 * Whether the command was refused for want of permission.
 *
 * This matters more than it looks, because of what PowerShell prints next.
 * Asked whether BitLocker was on, the model ran Get-BitLockerVolume, which
 * without elevation produced BOTH of these:
 *
 *   Get-CimInstance : Access denied ... PermissionDenied
 *   Get-Win32EncryptableVolumeInternal : C: does not have an associated
 *   BitLocker volume.
 *
 * The second line is a consequence of the first - the module could not
 * query, so it fell back to reporting no volume - and it reads exactly like
 * a definitive answer. The model duly said "BitLocker is not turned on for
 * the C drive", which is a claim about disk encryption drawn from a failure
 * to look.
 *
 * So a permission error is its own case, ahead of the ordinary failure
 * ending, and the report says plainly that everything after it is unsafe to
 * read.
 */
const PERMISSION_DENIED =
  /Access (is )?denied|PermissionDenied|UnauthorizedAccessException|requires elevation|Run as administrator|elevated (permissions|prompt|privileges)/i

export function needsElevation(result: Pick<ShellResult, 'stderr'>): boolean {
  return PERMISSION_DENIED.test(result.stderr)
}

/**
 * What to tell the model when the command was not allowed to look.
 *
 * The important half is not "it failed" - it is that the lines printed
 * afterwards are worthless, because a cmdlet that could not query will
 * often report absence rather than report nothing.
 */
export const NEEDS_ADMIN_ENDING = [
  'That command was REFUSED for want of permission. It did not fail to work',
  'and it did not find anything out — it was not allowed to look.',
  'You therefore know NOTHING about what was being checked.',
  'Anything else that command printed is unsafe to read. A cmdlet that was',
  'denied access frequently goes on to report that the thing is absent or',
  'not configured, because that is what it sees from behind the locked door.',
  'Observed: a denied BitLocker query also printed "C: does not have an',
  'associated BitLocker volume", and that was reported to the user as',
  'BitLocker being off. It was not an answer about BitLocker at all.',
  'NEVER report a security setting as off, absent or unconfigured on the',
  'strength of a permission error.',
  'Written as the model copied the previous wording verbatim and told the',
  'user "you cannot tell", which reads as them being unable to find out.',
  'The sentence is yours, in the first person:',
  '  I could not check that — the query needs an elevated prompt.',
  'Then name the command that would answer it and let them decide whether to',
  'run it as administrator.'
]

export const NOT_FOUND_ENDING = [
  'PowerShell looked for that program by name and there is nothing to run.',
  'That IS the answer: it is not installed, or at least not on PATH.',
  'Say so in words. Do NOT propose that command again — it will fail the',
  'same way every time, and nothing about it needs fixing.',
  'Do not read a version number out of an error message.',
  'One caveat worth stating if it applies: an APPLICATION can be installed',
  'and still not be on PATH. If they asked about an app rather than a',
  'terminal tool, say that this means it is not a terminal command, and',
  'offer the installed-check against the uninstall registry instead.'
]

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

/**
 * A long job that returned without ever saying it finished.
 *
 * Reported from real use, installing Claude Code: it did install, and it
 * was verified afterwards, but in between the reply said it was done when
 * it was not. The prompt already forbids claiming success in the same
 * message as the proposal, and that is not what happened here - the
 * command had come back. Exit 0 only means the command returned.
 *
 * The ordinary ending was pushing it. "That command is done. Do not
 * propose it again. Answer the original question from this output, in
 * words" is exactly wrong for an installer that got as far as "Starting
 * package install..." and stopped: it forbids the one command that would
 * settle it and asks for a conclusion the output does not support. A rule
 * in the prompt lost to it three times out of three, because the report is
 * the last thing in the context.
 */
export const UNFINISHED_ENDING = [
  'That command RETURNED, but nothing in its output says the work finished.',
  'An installer can hand off and keep going after the shell comes back, so',
  'exit code 0 here means the command ended, not that the program is on the',
  'machine.',
  'Do NOT say it is installed. Do NOT stop at "it is installing" either —',
  'the user cannot see any more than you can and you are holding the shell.',
  'Send ONE short, different command that checks: ask the tool itself for',
  'its version, or look it up by name. Then say what it found.'
]

/** Output that says the job actually got to the end. */
const FINISHED_MARKS =
  /successfully installed|successfully uninstalled|installation (completed|succeeded|finished)|already installed|no applicable (upgrade|update)|no newer package|added \d+ packages?|removed \d+ packages?|up to date|changed \d+ packages?/i

/** Output that says it had started, which is not the same thing. */
const STARTED_MARKS =
  /starting package install|\bdownloading\b|\binstalling\b|\bextracting\b|\bunpacking\b|verified installer hash|\bin progress\b/i

/**
 * Whether this looks like a job that began and never reported an end.
 *
 * Deliberately narrow. It only fires on a command that CHANGED something -
 * a read that happens to mention the word "downloading" is just text - and
 * only when the output both says it started and never says it finished.
 * Everything else keeps the ordinary ending, which is right for the reads
 * that are most of what Wumpy runs.
 */
export function startedButUnfinished(result: ShellResult): boolean {
  if (result.readOnly || result.timedOut || result.exitCode !== 0) return false
  const out = `${result.stdout}${result.stderr}`
  if (!out.trim()) return false
  return STARTED_MARKS.test(out) && !FINISHED_MARKS.test(out)
}

/**
 * A search that matched nothing, in folders somebody picked.
 *
 * The case that wrote this one, in full. Asked "find the exact file path to
 * a file called PD.cap", Wumpy searched Downloads, Documents and the
 * Desktop, got no output, and answered "The file PD.cap was not found in
 * your Downloads, Documents, or Desktop folders." The file was in
 * C:\DRIVERS\WIN\PD.
 *
 * Nothing in that is a lie - it even named its scope - and it is still the
 * wrong answer to the question that was asked. The user wanted a path.
 *
 * The ordinary ending is what pushed it there: "That command is done. Do
 * not propose it again. Answer the original question from this output, in
 * words" is an instruction to turn an empty result into a conclusion, and
 * an empty result from three guessed folders supports no conclusion at all.
 * So an empty search gets its own ending, which says what the emptiness
 * means and hands over the command that actually answers it.
 */
export const FOUND_NOTHING_ENDING = [
  'That search matched NOTHING, which is a fact about the folders you',
  'looked in and not about the thing you were looking for.',
  'Do NOT report it as missing. It is somewhere you did not look.',
  'This exact mistake: asked for the path of PD.cap, Wumpy searched',
  'Downloads, Documents and the Desktop, found nothing and said the file',
  'was not in those folders. It was in C:\\DRIVERS\\WIN. A near miss reads',
  'exactly like an answer, which is worse than no answer at all.',
  'So say which folders you actually searched, and in the SAME reply send',
  'the search that covers the whole drive. One command does it:',
  '  cmd /c "dir C:\\PD.cap /s /b"',
  'with their filename in place of PD.cap. Every folder on C:, full paths',
  'and nothing else, 74 seconds on this machine — say the minute is coming.',
  'If that prints File Not Found, THEN it is not on that drive.',
  'If you were searching inside files rather than for a filename, the rule',
  'is the same: widen the scope in one more command, and say what you did.'
]

/**
 * The same search, over a whole drive, which really did look everywhere.
 *
 * dir reports this as "File Not Found" on stderr with a non-zero exit, and
 * without this it reads as a failure - FAILED_ENDING would tell the model
 * the command did not do what was asked and to find another way, when in
 * fact it did exactly what was asked and the answer is no. That would turn
 * a finished search into a retry, which is the loop NOT_FOUND_ENDING was
 * written to stop in the docker case.
 */
export const NOT_ON_THIS_DRIVE_ENDING = [
  'That search covered the whole drive and found nothing.',
  'It did NOT fail: "File Not Found" is dir saying it looked everywhere it',
  'was pointed at, and the non-zero exit means that and nothing more.',
  'So this IS the answer. Say it plainly, and name the drive you searched.',
  'Do not run it again, and do not fall back to guessing folders — you',
  'have already covered every folder there is.',
  'Two things are worth ONE more command each, if they apply: another',
  'drive, and a different spelling or extension if the name you were given',
  'may not be exact. Say which of those you are doing, or ask.'
]

/** The tools that search rather than report. */
const SEARCHES = /\b(Get-ChildItem|gci|ls|dir|where(\.exe)?|Select-String|sls|findstr)\b/i

/** Looking below the folder it was given, rather than at it. */
const EVERY_SUBFOLDER = /-Recurse\b|\s\/s\b|\s\/r\b/i

/** dir and where.exe saying they looked and there was nothing. */
const NOTHING_MATCHED = /^\s*File Not Found\s*$|Could not find files for the given pattern/im

/**
 * Rooted at a drive rather than at a folder inside one.
 *
 * `C:\` and `C:\PD.cap` match; `C:\Users\zecha\Downloads` does not. The
 * difference is the whole point: one of them has looked everywhere and the
 * other has looked in one place.
 */
const FROM_DRIVE_ROOT = /(?:^|\s)["']?[A-Za-z]:[\\/][^\\/\s"']*["']?(?=\s|"|$)/

/**
 * Whether this was a search, and whether it came back with nothing.
 *
 * Narrow on purpose. `Get-Command docker` printing nothing IS the answer -
 * it is a lookup, not a search - so the recursive marker is required. And a
 * command that failed for some other reason still has its own ending: the
 * emptiness has to be the SEARCH's emptiness, either an exit-0 run with no
 * output at all or one of the two messages that say so in words.
 */
export function searchedNothing(result: ShellResult): boolean {
  if (result.timedOut) return false
  if (!SEARCHES.test(result.command) || !EVERY_SUBFOLDER.test(result.command)) return false
  const out = `${result.stdout}${result.stderr}`
  if (!out.trim()) return result.exitCode === 0
  return NOTHING_MATCHED.test(out)
}

/** And whether it had covered everywhere by the time it found nothing. */
export function searchedWholeDrive(result: ShellResult): boolean {
  return FROM_DRIVE_ROOT.test(result.command)
}

/** How much command output the model is shown before it is clipped. */
export const MAX_REPORT_OUTPUT = 3000

export type CommandFeedback = { kind: 'notice'; text: string } | { kind: 'report'; text: string }

/**
 * What Wumpy tells the model after a command it approved has run.
 *
 * Extracted from the renderer so there is exactly one of it. bench-ceiling
 * now grades the SECOND turn - what the model says once it has read the
 * output - and a benchmark that writes its own version of this report is
 * measuring a conversation the app never has. The same reason titleBrief
 * lives in shared: a copy drifts, an import cannot.
 */
/** Everything a command printed, as one trimmed string. */
function printed(result: Pick<ShellResult, 'stdout' | 'stderr'>): string {
  return [result.stdout, result.stderr].filter(Boolean).join(String.fromCharCode(10)).trim()
}

/** Whether the model is being shown less than the command printed. */
export function wasClipped(result: Pick<ShellResult, 'stdout' | 'stderr'>): boolean {
  return printed(result).length > MAX_REPORT_OUTPUT
}

/** Everything a command printed, trimmed and clipped to what is shown. */
export function clippedOutput(result: Pick<ShellResult, 'stdout' | 'stderr'>): string {
  const body = printed(result)
  return body.length > MAX_REPORT_OUTPUT
    ? `${body.slice(0, MAX_REPORT_OUTPUT)}${String.fromCharCode(10)}…truncated…`
    : body
}

export function commandFeedback(result: ShellResult): CommandFeedback {
  const clipped = clippedOutput(result)

  // A change that succeeded and printed nothing has nothing to interpret.
  // Reads are different: `Get-Command foo` printing nothing is the answer
  // rather than the absence of one, so those always go back to the model.
  if (!result.readOnly && result.exitCode === 0 && !result.timedOut && !clipped) {
    return { kind: 'notice', text: `Ran \`${result.command}\` — succeeded, no output.` }
  }

  const ending = neverRan(result)
    ? NEVER_RAN_ENDING
    : notOnPath(result)
      ? NOT_FOUND_ENDING
      : // Ahead of the ordinary failure ending, and ahead of success too: a
        // command can print real output and still have been denied half of
        // what it asked for.
        needsElevation(result)
        ? NEEDS_ADMIN_ENDING
        : // Ahead of the failure ending because a drive-wide dir that found
          // nothing exits non-zero, and that exit code is the answer rather
          // than a fault. Behind the three above because a search that could
          // not parse, could not run or was denied has not searched at all.
          searchedNothing(result)
          ? searchedWholeDrive(result)
            ? NOT_ON_THIS_DRIVE_ENDING
            : FOUND_NOTHING_ENDING
          : result.exitCode !== 0 && !result.timedOut
            ? FAILED_ENDING
            : result.timedOut
              ? [
                  'Wumpy STOPPED that command before it finished — it hit the time limit.',
                  'Whatever it was doing may still be running in the background, and the',
                  'output above is only what it had printed so far.',
                  'Do NOT say it succeeded, and do not say it failed. Say it was still',
                  'going, then propose ONE command that checks the real state.'
                ]
              : startedButUnfinished(result)
                ? UNFINISHED_ENDING
                : [
                    'That command is done. Do not propose it again. Answer the original',
                    'question from this output, in words.'
                  ]

  const NL = String.fromCharCode(10)

  /**
   * A note appended to whatever ending applies, rather than an ending of its
   * own, because it can accompany a perfectly successful command.
   *
   * 0.0.0.0 is what Get-Command reports for a binary with no version
   * resource - ollama, for one, whose real version is 0.40.1. The model read
   * the column and told the user "you have version 0.0.0.0 of Ollama". The
   * prompt already forbade that; one run in two did it anyway, so the report
   * says it at the moment the figure is actually on screen.
   */
  /**
   * Output that was cut off, said in words rather than left as a marker.
   *
   * The report already ends the fence with a truncation marker, and the
   * model read straight past it: asked to list every installed program it
   * presented the first 3000 characters as the whole list, twice out of two.
   * The ordinary ending does not help - "answer the original question from
   * this output" is an invitation to treat what is there as all there is.
   */
  // Compared against the limit, not against the clipped string. Comparing
  // lengths looked right and was wrong: the truncation marker makes the
  // clipped text LONGER than a body that only just overflowed, so 3001
  // characters of output were never flagged. A check caught it.
  const clippedNote = wasClipped(result)
    ? [
        '',
        'NOTE: that output was CUT OFF — you are seeing the first part of it,',
        'not all of it. Do not give a total, a count, or say "all" or "these',
        'are the" from it. Say it is the first part, and if they need the',
        'whole thing propose a command that counts or filters instead of',
        'one that lists.'
      ]
    : []

  const versionNote = /(^|[^\d.])0\.0\.0\.0([^\d.]|$)/.test(clipped)
    ? [
        '',
        'NOTE: 0.0.0.0 in that output is not a version. It is what Windows',
        'reports for a file carrying no version resource. Do not pass it on as',
        'a version — ask the tool itself, with its own --version flag.'
      ]
    : []
  const notes = [...clippedNote, ...versionNote]

  return {
    kind: 'report',
    text: [
      neverRan(result)
        ? `That command could not run. Exit code ${result.exitCode}.`
        : `I ran that command. Exit code ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}.`,
      '',
      clipped ? ['```', clipped, '```'].join(NL) : '(no output)',
      ...notes,
      '',
      ...ending
    ].join(NL)
  }
}

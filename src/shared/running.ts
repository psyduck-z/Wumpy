/**
 * What to say while a command is still going.
 *
 * The card used to say "running…" and nothing else for up to the ten-minute
 * ceiling. A winget install takes two or three minutes, during which the only
 * thing on screen was a word that never changed — indistinguishable from
 * frozen, for an install that was in fact working.
 *
 * The obvious fix is a spinner with a rotating vocabulary. This is not that.
 * A word that changes every three seconds is motion without information, and
 * once it has lied to you about what it is doing you stop reading it. Every
 * verb here is either taken from what the command actually printed a moment
 * ago, or from what the command plainly is. "downloading" appears because
 * winget said "Downloading", not because 4.2 seconds have passed.
 *
 * Pure on purpose: the renderer animates, this decides, and the decision can
 * be tested without a window.
 */

/** A word for what is happening, and an optional line about how long it has taken. */
export interface RunningPhase {
  /** Lower-case gerund, shown with the animated dots after it. */
  verb: string
  /** Said only once the wait is long enough to need explaining. */
  note: string | null
}

/**
 * Taken from the command's own output, which is the only source here that
 * cannot be wrong.
 *
 * Ordered by nothing — the match that occurs latest in the output wins, so a
 * run that downloads and then installs says "installing" once it has moved on.
 */
const FROM_OUTPUT: ReadonlyArray<{ re: RegExp; verb: string }> = [
  { re: /\b(downloading|fetching|retrieving|resolving packages)\b/i, verb: 'downloading' },
  { re: /\b(installing|starting package install)\b/i, verb: 'installing' },
  { re: /\b(uninstalling|removing)\b/i, verb: 'uninstalling' },
  { re: /\b(extracting|unpacking|expanding)\b/i, verb: 'unpacking' },
  { re: /\b(verifying|validating|checking hash|successfully verified)\b/i, verb: 'verifying' },
  { re: /\b(building|compiling)\b/i, verb: 'building' },
  { re: /\b(copying|copied file)\b/i, verb: 'copying' },
  { re: /\b(searching|scanning)\b/i, verb: 'searching' }
]

/**
 * Taken from the command, used until it has printed anything.
 *
 * First match wins here, so the more specific patterns come first: `winget
 * uninstall` must not be read as an install because "install" is a substring
 * of the word.
 */
const FROM_COMMAND: ReadonlyArray<{ re: RegExp; verb: string }> = [
  {
    re: /\b(winget|choco|scoop|pip|pip3)\s+uninstall\b|\bUninstall-Package\b|\bmsiexec\b[^|]*\/(x|uninstall)\b/i,
    verb: 'uninstalling'
  },
  { re: /\bwinget\s+(search|show|list)\b|\bchoco\s+search\b|\bFind-Package\b/i, verb: 'searching' },
  {
    re: /\b(winget|choco|scoop)\s+(install|upgrade)\b|\bnpm\s+(i|install|ci)\b|\b(pip|pip3)\s+install\b|\bmsiexec\b[^|]*\/i\b|\bInstall-Module\b|\bInstall-Package\b/i,
    verb: 'installing'
  },
  {
    re: /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget|Start-BitsTransfer)\b/i,
    verb: 'downloading'
  },
  {
    re: /\b(Test-NetConnection|Resolve-DnsName|ping|tracert|nslookup)\b/i,
    verb: 'waiting on the network'
  },
  { re: /\b(Expand-Archive|tar|unzip)\b/i, verb: 'unpacking' },
  { re: /\bCompress-Archive\b/i, verb: 'compressing' },
  { re: /\b(Remove-Item|del|rmdir|Uninstall)\b/i, verb: 'deleting' },
  { re: /\b(Copy-Item|robocopy|xcopy)\b/i, verb: 'copying' },
  { re: /\bMove-Item\b/i, verb: 'moving' },
  {
    /* `dir /s` with the thing it is looking for in between, because the
       whole-drive search by name is written `dir C:\that.name /s /b` and
       spends about 74 seconds on this machine saying nothing. A minute of
       "running…" is the exact case this file exists for. */
    re: /-Recurse\b|\bdir\b[^|]*?\s\/s\b|\b(Select-String|findstr|where\.exe)\b|\bGet-ChildItem\b/i,
    verb: 'searching'
  },
  { re: /\bStart-Process\b/i, verb: 'starting it' },
  { re: /\b(git)\s+(clone|pull|fetch|push)\b/i, verb: 'talking to git' },
  { re: /\b(Get-|Test-|Measure-|Resolve-)\w+|--version\b|-version\b/i, verb: 'checking' }
]

/** Index of the last place a pattern matches, or -1. */
function lastMatch(text: string, re: RegExp): number {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let at = -1
  let m: RegExpExecArray | null
  while ((m = all.exec(text)) !== null) {
    at = m.index
    if (all.lastIndex === m.index) all.lastIndex++
  }
  return at
}

/** Work out the verb and, if the wait is getting long, a line explaining it. */
export function runningPhase(command: string, output: string, seconds: number): RunningPhase {
  // Only the tail is read: a long install mentions "Downloading" once near the
  // top and stays there, and it is the latest thing that is true.
  const tail = output.slice(-20000)

  let verb = ''
  let best = -1
  for (const sign of FROM_OUTPUT) {
    const at = lastMatch(tail, sign.re)
    if (at > best) {
      best = at
      verb = sign.verb
    }
  }

  if (!verb) {
    for (const sign of FROM_COMMAND) {
      if (sign.re.test(command)) {
        verb = sign.verb
        break
      }
    }
  }
  if (!verb) verb = 'running'

  const slow = verb === 'installing' || verb === 'downloading' || verb === 'uninstalling'
  const quiet = output.trim() === ''

  let note: string | null = null
  if (seconds >= 540) note = 'it will be stopped at ten minutes'
  else if (seconds >= 180) note = 'this is unusually long'
  else if (seconds >= 60) note = quiet ? 'over a minute, nothing printed yet' : 'over a minute in'
  else if (seconds >= 20) note = slow ? 'installers can take a few minutes' : 'still going'

  return { verb, note }
}

/* eslint-disable no-control-regex */
/**
 * Colour and cursor codes, which winget emits even with NO_COLOR set.
 *
 * Built from a character code rather than written as an escape, because an
 * ESC typed literally into a source file is invisible in every editor and
 * every diff — the same class of bug as the seven stray backspaces that once
 * lived in the grader.
 */
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\-_]`, 'g')
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * The last few lines of live output, as something worth watching.
 *
 * Progress bars redraw with a carriage return rather than a newline, so a
 * naive split on newlines shows one enormous line that grows sideways. Each
 * carriage return starts a line here, which is what the terminal does with
 * it, and the redraws collapse into the last frame of the bar.
 */
export function tailLines(text: string, max: number): string[] {
  const lines = stripAnsi(text)
    .split(/\r\n|\n|\r/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
  return lines.slice(-max)
}

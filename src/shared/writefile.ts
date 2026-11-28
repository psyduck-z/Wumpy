/**
 * Writing a file, without a shell anywhere near it.
 *
 * This exists because of one observed failure, repeated until the session was
 * unusable. Asked to create a Python script, a 3.8B model wrote:
 *
 *     New-Item -Path "$HOME\Downloads\list_specs.py" -ItemType file -Content {
 *     import os
 *     ...
 *     }
 *
 * PowerShell reads `{ ... }` as a script block, so every line of the Python was
 * parsed as PowerShell. The result was eight parser errors, which the model then
 * read as mistakes in its own Python and "corrected" - producing a second script
 * with the same problem, and a conversation that could never converge because
 * the errors were never in the Python at all.
 *
 * Getting a multi-line file into a shell command needs a here-string and exact
 * escaping, and a small model will not produce one reliably. So it does not have
 * to: the content goes in a block, Wumpy writes it with the filesystem API, and
 * there is no quoting layer to get wrong. Nothing here is interpreted - not `$`,
 * not a backtick, not a brace.
 */

export interface WriteRequest {
  /** The `#` lines, shown on the card. */
  reason: string | null
  /** The path as written, before resolution. */
  path: string | null
  /** Exactly what should end up in the file. */
  content: string
  /** "agent-7": the file is that background agent's, saved as it wrote it. */
  from?: string | null
}

/** A file this size is a mistake, not a script. */
export const MAX_BYTES = 256 * 1024

/**
 * Reads a `wumpy-write` block.
 *
 *     # why this file
 *     path: ~/Downloads/analysis.py
 *     ---
 *     <content, verbatim>
 *
 * The separator is optional, because a small model will forget it: without one,
 * the content simply starts after the path line. Everything after the split is
 * taken exactly as it is - no trimming of interior lines, no unescaping - since
 * a file's content is the one thing in this app that must survive untouched.
 */
export function readWriteRequest(raw: string): WriteRequest {
  const lines = raw.split('\n')

  const reason: string[] = []
  let path: string | null = null
  let start = -1
  let fromAgent: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('#') && path === null) {
      reason.push(trimmed.replace(/^#+\s*/, ''))
      continue
    }
    if (path === null) {
      const match = /^path:\s*(.+)$/i.exec(trimmed)
      if (match) {
        path = match[1].trim().replace(/^["'`]|["'`]$/g, '')
        continue
      }
      // Anything else before a path line is noise the model added.
      if (trimmed) continue
      continue
    }
    /* A file a background agent wrote is saved from its report, not
       retyped: `from: agent-7` straight after the path. */
    const from = start === -1 ? /^from:\s*(agent-\d+)\s*$/i.exec(trimmed) : null
    if (from) {
      fromAgent = from[1].toLowerCase()
      continue
    }
    // Past the path. A separator line is consumed; anything else starts the file.
    if (start === -1) {
      if (/^-{3,}$/.test(trimmed)) {
        start = i + 1
        break
      }
      if (trimmed === '') continue
      start = i
      break
    }
  }

  const content = start === -1 ? '' : lines.slice(start).join('\n')
  return {
    reason: reason.join(' ').trim() || null,
    path,
    /* With a from: line the file is the agent's, whatever follows it: a
       chat that could not see the agent's tested Snake wrote from: and then
       a Snake of its own invention, which did not move. */
    content: fromAgent ? '' : content,
    from: fromAgent
  }
}

/* ------------------------------------------------------------ where it may go */

export interface WriteCheck {
  ok: boolean
  /** The absolute path this resolves to. Empty when refused. */
  path: string
  why: string | null
}

/**
 * Folders a file must never be written into, however the path was spelled.
 *
 * Startup is the one that matters: a file dropped there runs at every login, so
 * it is the difference between "wrote a script" and "installed something". The
 * rest are places nothing a chat window produced belongs.
 */
const FORBIDDEN = [
  /\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup(\\|$)/i,
  /\\appdata\\roaming\\microsoft\\windows\\start menu(\\|$)/i,
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata\\microsoft\\windows\\start menu(\\|$)/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /\\appdata\\roaming\\microsoft\\windows\\recent(\\|$)/i,
  // Linux: the places that start things at login, which is what Startup is
  // on Windows - an autostart entry and a user service. (Hyprland's config
  // and the shell's start-up files are protected places below: asked about,
  // not refused, since a keybinding is a fair thing to want.)
  /\/\.config\/autostart(\/|$)/,
  /\/\.config\/systemd(\/|$)/
]

/** Windows's own reserved device names, which are not files and behave oddly. */
const DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * Resolves and vets a destination.
 *
 * `resolve` and `normalise` are passed in rather than imported so this stays a
 * pure function the checks can drive with any home directory on any platform;
 * the main process hands it node's path module.
 */
export function checkWritePath(
  raw: string,
  env: {
    home: string
    cwd: string
    resolve(...parts: string[]): string
    separator: string
  }
): WriteCheck {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, path: '', why: 'No path was given.' }
  if (text.length > 400) return { ok: false, path: '', why: 'That path is too long.' }
  if (/[\u0000-\u001f]/.test(text)) {
    return { ok: false, path: '', why: 'That path has control characters in it.' }
  }
  // A wildcard is not a destination, and nor is a stream name.
  if (/[*?]/.test(text)) return { ok: false, path: '', why: 'A path cannot have wildcards in it.' }
  // "<the path they asked for>", copied from a template instead of filled in.
  if (/<[^>]*>/.test(text)) return { ok: false, path: '', why: 'That path is still a placeholder: put in where the file goes.' }

  // The spellings a model actually produces for the home directory.
  let expanded = text
    .replace(/^~(?=[\\/]|$)/, env.home)
    .replace(/\$env:USERPROFILE/gi, env.home)
    .replace(/%USERPROFILE%/gi, env.home)
    .replace(/\$HOME/g, env.home)
    .replace(/\$\{HOME\}/g, env.home)

  // A UNC path reaches another machine, which is not what "write a file" means.
  if (/^\\\\/.test(expanded)) {
    return { ok: false, path: '', why: 'That is a network path, not a file on this PC.' }
  }

  const absolute = env.resolve(env.cwd || env.home, expanded)

  const base = absolute.split(/[\\/]/).pop() ?? ''
  if (DEVICES.test(base)) {
    return { ok: false, path: '', why: `${base} is a reserved Windows device name.` }
  }
  if (!base || base === '.' || base === '..') {
    return { ok: false, path: '', why: 'That path has no file name on the end.' }
  }

  /**
   * Inside the home directory, and nowhere else.
   *
   * Checked after resolving, so `~/Downloads/../../Windows/System32/x.dll` is
   * caught by where it lands rather than by how it is written.
   */
  const home = env.resolve(env.home)
  if (absolute.toLowerCase() === home.toLowerCase()) {
    // `~/Downloads/..` resolves to the home folder itself, which is a directory
    // and not somewhere a file can be written.
    return { ok: false, path: absolute, why: 'That path has no file name on the end.' }
  }
  const inside = absolute.toLowerCase().startsWith(home.toLowerCase() + env.separator)
  if (!inside) {
    return {
      ok: false,
      path: absolute,
      why: `Outside your home folder. Wumpy writes files under ${home} only.`
    }
  }

  for (const pattern of FORBIDDEN) {
    if (pattern.test(absolute)) {
      /**
       * Says what to do instead, because a refusal the model cannot act on
       * is a dead end that costs a click and then repeats.
       *
       * Asked to open Notepad at login, the model proposed a write into
       * Start Menu/Programs/Startup two times in three even after the
       * prompt was told not to. Telling it louder was the wrong lever: the
       * app knows exactly why it said no and exactly what would have
       * worked, and saying so turns the failure into one recovered turn.
       */
      const persistence = /start\s*menu|startup/i.test(absolute)
      return {
        ok: false,
        path: absolute,
        why: persistence
          ? 'That folder makes files run by themselves at every login, which is ' +
            'installing something rather than writing a file. Wumpy will not write ' +
            'there. For something that runs at login, propose a command instead — a ' +
            'scheduled task with New-ScheduledTaskTrigger -AtLogOn — which raises a ' +
            'confirmation the user can read.'
          : 'That folder makes files run by themselves or holds credentials. Wumpy ' +
            'will not write there. Pick somewhere under the home folder, or say ' +
            'plainly that this is not something Wumpy can do.'
      }
    }
  }

  return { ok: true, path: absolute, why: null }
}

/* ------------------------------------------------------------------- prompting */

/**
 * What the model is told.
 *
 * Telling it to be terse was tried and is not here. Measured over four requests:
 * 628 tokens as it is against 599 with a "say one sentence, then stop, never
 * repeat the contents" rule - inside the noise - and the prose *after* the block
 * actually grew, from 59 to 93 characters. The answers were already short. What
 * was costing minutes was the failure loop, not the prose.
 *
 * The `python "<path>"` line is in here because of the other half of the same
 * failure: having created a script, the model proposed running it as
 * `$HOME\Downloads\folder_analysis.py` on its own, which PowerShell reads as an
 * expression and rejects with "Unexpected token".
 */
export const WRITE_PROMPT = [
  'To create or replace a FILE, never use a shell command — use a wumpy-write block.',
  'One exception, and it is at the top because it is where the mistake gets',
  'made: a file that is meant to RUN BY ITSELF later is not a file write.',
  'Startup, the Start Menu, Windows, Program Files, .ssh and .aws are all',
  'refused outright, so anything about logging in, starting up or running on',
  'a schedule is a COMMAND. Details at the end.',
  'A # line saying why, a path: line, then --- and the exact contents.',
  '',
  '```wumpy-write',
  '# Create the folder analysis script',
  'path: ~/Downloads/folder_analysis.py',
  '---',
  'import os',
  '',
  'print(sum(os.path.getsize(f) for f in os.listdir(".") if os.path.isfile(f)))',
  '```',
  '',
  'A GAME, PAGE, APP OR WHOLE PROGRAM is a background agent\'s job when you have them (see',
  'there): you write its file when the report comes. CODE THAT RUNS IS NOT DONE WHEN IT IS',
  'WRITTEN: run it in your head first - every name defined where used, every speed per second',
  'times the frame time, every part they asked for there. Wumpy loads a page and compiles a',
  'program you write, and hands you the errors. When they say it does not work, READ THE FILE',
  'before you answer - never guess a cause - and fix all that is wrong, not only what they named.',
  '',
  'The contents are written exactly as given, so write plain code: no escaping, no',
  'quoting, no here-string. Never put file contents inside New-Item, Set-Content or',
  'echo — braces and quotes in a shell will mangle them.',
  'To run a Python file afterwards, the command is: python "<full path>"',
  '',
  'A WRITE BLOCK CANNOT REACH EVERYWHERE, SO DO NOT OFFER TO.',
  'Wumpy REFUSES a write into the Startup folder, the Start Menu, the',
  'Windows folder, Program Files, .ssh or .aws — outright, not with a',
  'confirmation. Proposing one of those is a card that cannot work, which',
  'spends their click and then fails.',
  'Asked to open Notepad at every login, Wumpy offered a write block',
  'pointing into Start Menu/Programs/Startup. That is the one path the',
  'refusal exists for: a file dropped there runs at every login, which is',
  'installing something rather than writing a file.',
  'Login persistence is a COMMAND, not a write. A scheduled task or a Run',
  'key entry both work and both raise a native confirmation, so the user is',
  'told what is being set up and decides:',
  '  Register-ScheduledTask -TaskName <name> -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Action (New-ScheduledTaskAction -Execute notepad.exe)',
  'Say which you are using and why, in one line.'
].join(String.fromCharCode(10))

/**
 * WRITE_PROMPT for Linux. The Windows one went out on Omarchy word for word:
 * the Startup folder, the Start Menu, Program Files, New-Item and
 * Register-ScheduledTask, none of which exist there - about 300 tokens a
 * turn describing another machine, followed by three lines correcting it.
 * The same rules, with this machine's places and commands.
 */
export const LINUX_WRITE_PROMPT = [
  'To create or replace a FILE, never use a shell command — use a wumpy-write block.',
  'One exception: a file meant to RUN BY ITSELF later (at login, as a service, on a',
  'schedule) is not a file write. ~/.config/autostart, ~/.config/systemd, ~/.ssh and',
  '~/.aws are refused outright, so that is a COMMAND (systemctl --user enable,',
  'a Hyprland exec-once line) - say which and why, in one line. ~/.config/hypr and',
  'the shell start-up files (.bashrc, .profile) are asked about first.',
  'A # line saying why, a path: line, then --- and the exact contents.',
  '',
  '```wumpy-write',
  '# Create the folder analysis script',
  'path: ~/Downloads/folder_analysis.py',
  '---',
  'import os',
  '',
  'print(sum(os.path.getsize(f) for f in os.listdir(".") if os.path.isfile(f)))',
  '```',
  '',
  'A GAME, PAGE, APP OR WHOLE PROGRAM is a background agent\'s job when you have them (see',
  'there): you write its file when the report comes. CODE THAT RUNS IS NOT DONE WHEN IT IS',
  'WRITTEN: run it in your head first - every name defined where used, every speed per second',
  'times the frame time, every part they asked for there. Wumpy loads a page and compiles a',
  'program you write, and hands you the errors. When they say it does not work, READ THE FILE',
  'before you answer - never guess a cause - and fix all that is wrong, not only what they named.',
  '',
  'The contents are written exactly as given, so write plain code: no escaping, no',
  'quoting, no heredoc. Never put file contents inside echo, printf or cat <<EOF —',
  'braces and quotes in a shell will mangle them.',
  'To run a Python file afterwards, the command is: python3 "<full path>"'
].join(String.fromCharCode(10))

/**
 * The same protected places, recognised inside an arbitrary command string.
 *
 * FORBIDDEN above vets a RESOLVED destination for the write-file card, and
 * it guards that door well. It is not the only door. Measured: of seven
 * commands that write into places this file refuses, six raised no dialog
 * at all - and on accept-all a command that is not flagged runs by itself.
 * The one the model actually proposed, asked to open Notepad at login, built
 * a .lnk in the Startup folder through WScript.Shell, where there is no
 * write verb for anything to notice:
 *
 *   $WshShell = New-Object -ComObject WScript.Shell
 *   $s = $WshShell.CreateShortcut("$env:APPDATA\...\Startup\Notepad.lnk")
 *   $s.Save()
 *
 * So the place matters however the command spells it. These patterns are
 * separator-agnostic and unanchored, because a command carries its path
 * inline - possibly behind $env:APPDATA, possibly with forward slashes -
 * rather than resolved. Kept beside FORBIDDEN so the two lists are read
 * together and neither grows without the other.
 */
const PROTECTED_PLACES: Array<{ name: string; pattern: RegExp }> = [
  // Startup first: it is the one that turns a file into an installation.
  // Every separator class is [\\/] - a backslash OR a slash. Written [\/]
  // it is a forward slash and nothing else, because the backslash only
  // escapes the slash, and then none of these ever matches a Windows path.
  // That exact mistake shipped in three graders earlier today.
  {
    name: 'the Startup folder, so it runs at every login',
    pattern: /start\s*menu[\\/]+programs[\\/]+startup/i
  },
  { name: 'the Start Menu', pattern: /start\s*menu[\\/]/i },
  { name: 'the Windows folder', pattern: /[a-z]:[\\/]+windows[\\/]/i },
  { name: 'Program Files', pattern: /[a-z]:[\\/]+program files( \(x86\))?[\\/]/i },
  { name: 'the .ssh folder, where keys live', pattern: /[\\/]\.ssh([\\/]|["'\s]|$)/i },
  { name: 'the .aws folder, where credentials live', pattern: /[\\/]\.aws([\\/]|["'\s]|$)/i },
  { name: 'the .gnupg folder, where keys live', pattern: /[\\/]\.gnupg([\\/]|["'\s]|$)/i },
  // Linux places that run things at every login, like Startup on Windows.
  { name: 'autostart, so it runs at every login', pattern: /\.config\/autostart\b/ },
  { name: 'systemd, so it runs as a service', pattern: /\.config\/systemd\b/ },
  { name: 'Hyprland’s config, which runs things at every login', pattern: /\.config\/hypr\b/ },
  { name: 'a shell start-up file', pattern: /[\\/]\.(bashrc|bash_profile|profile|zshrc|zprofile)(["'\s]|$)/ }
]

/** Which protected place a command text mentions, or null. */
export function protectedPlace(command: string): string | null {
  for (const { name, pattern } of PROTECTED_PLACES) {
    if (pattern.test(command)) return name
  }
  return null
}

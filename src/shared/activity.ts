/**
 * What the model is doing right now, in four or five words.
 *
 * Asked for so a turn going the wrong way can be stopped early: "small notes
 * of what the ai is doing... so i can stop it when i sense its going the
 * wrong direction". The cards already show every proposal in full, but they
 * arrive late - a card is only legible once its block is closed - and they
 * are in the transcript, which scrolls. This is one line, pinned, and it
 * appears on the FIRST line inside a fence.
 *
 * That timing is the whole point, and it is why the reason line is preferred
 * over the payload. The model is told to open every block with `# why`, so
 * "Searching · what version of Electron ships Node 22" is on screen while the
 * query itself is still being typed. Waiting for the command would cost the
 * seconds this exists to save.
 *
 * Pure, and shared rather than living in the renderer, so it can be checked
 * against real streamed text without a window.
 */

export type ActivityKind =
  | 'run'
  | 'search'
  | 'open'
  | 'write'
  | 'ask'
  | 'screen'
  | 'reply'
  | 'think'

export interface Activity {
  kind: ActivityKind
  /** A short verb phrase: "Searching". */
  label: string
  /** The concrete object: a reason, a query, a filename. Already shortened. */
  detail: string | null
  /** How many blocks of this kind are in the message so far. */
  count: number
  /** True while the block is still being written. */
  open: boolean
}

const NL = String.fromCharCode(10)

/**
 * The tags, with the run variants spelled out.
 *
 * Not built from WUMPY_TAGS: `run-cmd` and `run-bash` are produced by
 * normaliseFences and never appear in that list, and a note that goes blank
 * for exactly the models that need fence normalisation is a note that is
 * missing when it is most needed.
 */
const TAGS: Record<string, ActivityKind> = {
  run: 'run',
  'run-cmd': 'run',
  'run-bash': 'run',
  ask: 'ask',
  write: 'write',
  search: 'search',
  open: 'open',
  screen: 'screen'
}

const LABELS: Record<ActivityKind, string> = {
  run: 'Running',
  search: 'Searching',
  open: 'Opening',
  write: 'Writing',
  ask: 'Asking',
  screen: 'Looking at the screen',
  reply: 'Writing a reply',
  think: 'Thinking'
}

/** Long enough to be a sentence, short enough for one line in a 440px panel. */
export const DETAIL_CHARS = 52

export function shorten(text: string, limit = DETAIL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  /* On a word boundary when there is one near the end, so it does not cut
     mid-word and read as a typo. */
  const cut = flat.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit - 14 ? cut.slice(0, space) : cut).trimEnd()}…`
}

interface Block {
  kind: ActivityKind
  body: string[]
  open: boolean
}

/**
 * Every Wumpy block in the text, in order, with the last one possibly open.
 *
 * Fences are tracked generically rather than by looking for our own closing
 * tag, because a plain ``` code block inside a reply has a closing fence too
 * and treating that as ours would end the wrong block.
 */
function blocksIn(text: string): Block[] {
  const blocks: Block[] = []
  let current: Block | null = null
  let insideOther = false

  for (const line of text.split(NL)) {
    const fence = /^\s*```\s*([\w-]*)/.exec(line)
    if (fence) {
      if (current) {
        current.open = false
        current = null
        continue
      }
      if (insideOther) {
        insideOther = false
        continue
      }
      const tag = /^wumpy-(.+)$/.exec(fence[1].toLowerCase())
      const kind = tag ? TAGS[tag[1]] : undefined
      if (kind) {
        current = { kind, body: [], open: true }
        blocks.push(current)
      } else {
        insideOther = true
      }
      continue
    }
    if (current) current.body.push(line)
  }
  return blocks
}

/** The `# why` line the model is told to open every block with. */
function reasonOf(body: string[]): string | null {
  const line = body.find((l) => l.trim().startsWith('#'))
  if (!line) return null
  const text = line.trim().replace(/^#+\s*/, '').trim()
  return text || null
}

/** The first line that is not the reason and not blank. */
function payloadOf(body: string[]): string | null {
  const line = body.find((l) => l.trim() && !l.trim().startsWith('#'))
  return line ? line.trim() : null
}

/**
 * What a shell command is actually for, so the note says it.
 *
 * "Running" is true of every wumpy-run block and therefore says nothing -
 * asked for by name: "add other ones too... for example, checking (e.g what
 * model this pc is)". Checking the PC model and uninstalling a program are
 * the same tag and should not read the same, because the whole purpose of
 * the line is deciding whether to stop it.
 *
 * Ordered, and the order is the meaning: a pipeline that reads and then acts
 * is named for the acting. `Get-StartApps | ... | Start-Process` is Opening,
 * not Checking, and `Get-Process ollama | Stop-Process` is Stopping. So the
 * read verbs come last and only win when nothing else matched.
 *
 * This is a LABEL, not a permission. isReadOnly in the main process decides
 * what may run; nothing here is consulted for that, and a wrong guess costs
 * a wrong word rather than anything else. That is why it may be this short.
 */
const COMMAND_VERBS: Array<[RegExp, string]> = [
  [
    /\b(winget|choco|scoop)\s+(install|upgrade)\b|\bInstall-\w+|\bmsiexec\b(?![^|]*\/(x|uninstall))/i,
    'Installing'
  ],
  [
    /\b(winget|choco|scoop)\s+uninstall\b|\bUninstall-\w+|\bunins(tall)?[\w-]*\.exe\b|\bmsiexec\b[^|]*\/(x|uninstall)\b|\bRemove-Appx/i,
    'Uninstalling'
  ],
  [/\bStop-Process\b|\btaskkill\b|\bStop-Service\b|\bStop-Computer\b/i, 'Stopping'],
  [
    /\bRemove-Item\b|\bClear-(Content|RecycleBin)\b|(?:^|[|;&]\s*)\s*(del|erase|rd|rmdir)\b/i,
    'Deleting'
  ],
  [/\bStart-Process\b|\bStart-Service\b|\bexplorer(\.exe)?\b|shell:AppsFolder/i, 'Opening'],
  [
    /\b(Set|New|Add|Rename|Move|Copy|Disable|Enable|Restart)-\w+|\bOut-File\b|\bbcdedit\b|\bnetsh\b/i,
    'Changing'
  ],
  [
    /\b(Get|Test|Measure|Select|Resolve|Find|Compare)-\w+|\bwhere\.exe\b|--version\b|-Version\b|\bsysteminfo\b|\bwmic\b/i,
    'Checking'
  ]
]

/**
 * The same thing from the reason line, which arrives first.
 *
 * The command is the better evidence and the reason is the EARLIER evidence,
 * which is the one this feature is about. So the reason names the verb until
 * the command shows up and overrules it. The label sharpening mid-block is
 * fine; what must not happen is it going vague again, and a command that
 * matches nothing leaves the reason's verb standing rather than resetting to
 * "Running".
 */
const REASON_VERBS: Array<[RegExp, string]> = [
  [/^(install|set up|add)\b/i, 'Installing'],
  [/^(uninstall|get rid of)\b/i, 'Uninstalling'],
  [/^(stop|kill|quit|close|shut|end|terminate)\b/i, 'Stopping'],
  [/^(delete|clear|empty|wipe|erase)\b/i, 'Deleting'],
  [/^(open|launch|start|play)\b/i, 'Opening'],
  [/^(set|change|rename|move|copy|turn|enable|disable|restart|update)\b/i, 'Changing'],
  [/^(check|see|find|look|show|list|get|read|count|confirm|verify|work out|tell)\b/i, 'Checking']
]

function matchVerb(table: Array<[RegExp, string]>, text: string): string | null {
  for (const [pattern, verb] of table) if (pattern.test(text)) return verb
  return null
}

/**
 * The verb for a run block: the command's if there is one, else the reason's.
 */
function runVerb(body: string[]): string {
  const command = payloadOf(body)
  const fromCommand = command ? matchVerb(COMMAND_VERBS, command) : null
  if (fromCommand) return fromCommand
  const reason = reasonOf(body)
  const fromReason = reason ? matchVerb(REASON_VERBS, reason) : null
  return fromReason ?? LABELS.run
}

/**
 * Drops the reason's opening verb when the label has already said it.
 *
 * "Stopping · Stop the Ollama process" says it twice. Only when that first
 * word is what produced the label, so a reason whose verb disagrees with the
 * command keeps both halves - there the disagreement is the interesting part.
 */
function trimVerb(reason: string, label: string): string {
  const first = /^([a-z]+(?:\s+(?:up|out|of|rid of))?)\b\s*/i.exec(reason)
  if (!first) return reason
  if (matchVerb(REASON_VERBS, reason) !== label) return reason
  const rest = reason.slice(first[0].length).trim()
  return rest.length > 2 ? rest : reason
}

function detailFor(kind: ActivityKind, body: string[], label: string): string | null {
  const reason = reasonOf(body)
  const payload = payloadOf(body)

  if (kind === 'write') {
    /* The filename, because that is the thing worth stopping over. */
    const path = body.map((l) => /^\s*path:\s*(.+)$/i.exec(l)).find(Boolean)
    const file = path?.[1].trim().replace(/^["'`]|["'`]$/g, '')
    const base = file ? file.split(/[\\/]/).filter(Boolean).pop() : null
    if (base) return shorten(base)
    return reason ? shorten(reason) : null
  }

  if (kind === 'open' && payload) {
    const asSearch = /^search:\s*(.+)$/i.exec(payload)
    if (asSearch) return shorten(asSearch[1])
    try {
      return shorten(new URL(payload).hostname.replace(/^www\./, ''))
    } catch {
      /* Not a URL yet - still arriving, or a reason line only. */
    }
  }

  if (kind === 'ask' && !reason && payload) return shorten(payload)

  /* "Stopping · Stop the Ollama process" says it twice; drop the repeat. */
  if (reason) return shorten(kind === 'run' ? trimVerb(reason, label) : reason)
  return payload ? shorten(payload) : null
}

/**
 * What to show while `text` streams in, or null when there is nothing to say.
 *
 * `thinking` is the reasoning channel, which on a reasoning model arrives
 * well before the answer does. Without it the line stays empty for the whole
 * of a long think and the user has nothing to judge - which is the one stretch
 * where "is this going the wrong way" is hardest to answer and the dots say
 * only that something is happening.
 *
 * Still null when BOTH are empty: the dots already cover that, and two
 * indicators for one state is noise.
 */
export function activityFor(text: string, thinking = ''): Activity | null {
  const blocks = blocksIn(text)

  if (blocks.length === 0) {
    if (!text.trim()) {
      if (!thinking.trim()) return null
      return { kind: 'think', label: LABELS.think, detail: null, count: 1, open: true }
    }
    return { kind: 'reply', label: LABELS.reply, detail: null, count: 1, open: true }
  }

  /*
   * The open one if there is one, otherwise the last.
   *
   * After a block closes the model is usually finished, so keeping its note
   * up is truer than switching to "writing a reply" for the trailing
   * sentence. A new block replaces it the moment one opens.
   */
  const current = blocks.find((b) => b.open) ?? blocks[blocks.length - 1]
  const count = blocks.filter((b) => b.kind === current.kind).length
  const label = current.kind === 'run' ? runVerb(current.body) : LABELS[current.kind]

  return {
    kind: current.kind,
    label,
    detail: detailFor(current.kind, current.body, label),
    count,
    open: current.open
  }
}

/**
 * The whole note as one string, for a tooltip and for the checks.
 *
 * "Searching · 2 · what version of Electron ships Node 22"
 */
export function activityLine(a: Activity | null): string {
  if (!a) return ''
  const parts = [a.label]
  if (a.count > 1) parts.push(`${a.count}`)
  if (a.detail) parts.push(a.detail)
  return parts.join(' · ')
}

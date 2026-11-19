/**
 * Background agents: work the chat hands off, done on keys of their own.
 *
 * Asked for in these words: "allow like a background agent (much like
 * claude) that relieves stress on the ai... allow the background agents to
 * like help create things in the background, and give feedback to each
 * other (like the /reflect command)... allow them to create moniters... to
 * moniter the bg agents". And the warning that comes with it: "a bad one is
 * where EVERYTHING fails - wumpy becomes idiotic, the bg agents don't help,
 * and its a waste of time."
 *
 * The shape:
 *
 *   - The chat model starts one with a ```wumpy-agent block: a # line naming
 *     the task, then a brief that is all the agent will ever see.
 *   - It runs in the main process, on a key held for it, so the chat and the
 *     voice keep the others. It looks at the computer and the web only as far
 *     as the user's approval mode lets things run without a click: an agent
 *     never has more permission than the chat, and nobody is asked anything.
 *   - When it reports, a second agent reviews the report if a key is free -
 *     ACCEPT, or REVISE with notes the first agent then acts on, like
 *     /reflect's mentor.
 *   - The report goes back to the chat by itself. A ```wumpy-monitor block
 *     wakes the chat once several are done instead, with the note it left
 *     itself about what to do then. Monitors only watch agents, so they need
 *     no permission: they read what the app already knows.
 *
 * This file is the pure half - how many, what the blocks say, what each
 * model is told, how a reply is read - so all of it can be checked without a
 * key. main/agents.ts is the hands.
 */

const BT = String.fromCharCode(96).repeat(3)
const LF = String.fromCharCode(10)

/* ------------------------------------------------------------- how many */

/**
 * How many agents can work at once, for this many keys.
 *
 * In the user's words: "if i have 3 keys, the max i can have 2 bg agents,
 * and for 4, I could have 3, but at five, 4 bg agents is not gonna help, so
 * divide it in a ratio of chat:bg agents would be 2:3". So the chat keeps
 * one key up to four, and from five on the keys are shared two to the chat
 * for every three to agents, rounded - 3 of 5, 4 of 6, 6 of 10. One key is
 * the chat's, and no agents at all.
 */
export function agentSlots(keys: number): number {
  const n = Math.max(0, Math.floor(keys))
  if (n <= 1) return 0
  if (n <= 4) return n - 1
  return Math.round((n * 3) / 5)
}

/* ---------------------------------------------------------- the blocks */

export interface AgentAsk {
  title: string
  brief: string
}

export interface MonitorAsk {
  /** What the chat means to do when it fires: its note to itself. */
  note: string
  /** Wake once all of them are done, or as each one is. */
  when: 'all' | 'each'
  /** Agent numbers in this chat, or every agent still working. */
  agents: number[] | 'all'
}

function fencesOf(text: string, tag: string): string[] {
  const out: string[] = []
  /* "``` wumpy-agent", with a space, is the same block: models write it. */
  const pattern = new RegExp(`${BT}[ \\t]*(?:\\n[ \\t]*)?${tag}[^\\n]*\\n([\\s\\S]*?)(?:${BT}|$)`, 'g')
  for (const m of text.matchAll(pattern)) {
    /* Only a closed block counts: a half-written one is still arriving. */
    if (!m[0].endsWith(BT)) continue
    out.push(m[1])
  }
  return out
}

/** The agents a finished answer asks for, in order. A block with no brief is not one. */
export function agentAsks(text: string): AgentAsk[] {
  return fencesOf(text, 'wumpy-agent')
    .map((body) => {
      const lines = body.split(LF)
      const head = lines.findIndex((l) => l.trim())
      if (head < 0) return null
      const first = lines[head].trim()
      const titled = first.startsWith('#')
      const title = (titled ? first.replace(/^#+\s*/, '') : first).slice(0, 80)
      const brief = (titled ? lines.slice(head + 1) : lines.slice(head)).join(LF).trim()
      return brief.length >= 10 && title ? { title, brief } : null
    })
    .filter((a): a is AgentAsk => a !== null)
}

/** The monitors a finished answer sets. */
export function monitorAsks(text: string): MonitorAsk[] {
  return fencesOf(text, 'wumpy-monitor').map((body) => {
    let note = ''
    let when: MonitorAsk['when'] = 'all'
    let agents: MonitorAsk['agents'] = 'all'
    const rest: string[] = []
    for (const raw of body.split(LF)) {
      const line = raw.trim()
      if (!line) continue
      const whenIs = /^when\s*:\s*(.+)$/i.exec(line)
      const which = /^agents?\s*:\s*(.+)$/i.exec(line)
      if (whenIs) when = /\beach\b|\bany\b|\bevery\b|one by one|as each/i.test(whenIs[1]) ? 'each' : 'all'
      else if (which) {
        const numbers = [...which[1].matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0)
        agents = numbers.length ? numbers : 'all'
      } else if (!note && line.startsWith('#')) note = line.replace(/^#+\s*/, '')
      else rest.push(line)
    }
    return { note: (note || rest.join(' ')).slice(0, 300), when, agents }
  })
}

/* ------------------------------------------------- what an agent is told */

export interface AgentWorld {
  platform: 'win32' | 'linux' | 'darwin'
  /** The user's approval mode: what runs without a click. */
  mode: 'manual' | 'auto' | 'all'
  /** Whether it may search the web at all. */
  search: boolean
  /** Where commands run from. */
  cwd: string
  /** "Thursday 19 November 2026, 7:26 am". */
  now: string
  steps: number
  /** The brief is for something built: BUILDING is sent. */
  building?: boolean
}

/** The most tool uses one agent gets before it is told to report. */
export const AGENT_STEPS = 10

/**
 * What a built thing must do, sent when the brief is for one. Each line is
 * a way a game came back broken: a Snake whose Play Again hid the message
 * and left the snake standing for ever, its loop stopped at the game over;
 * one that ran into the wall a second and a half after loading, before
 * anyone touched a key; a Crossy Road whose cars crossed the road in a
 * twentieth of a second, moved per frame.
 */
export const BUILDING = [
  'BUILDING A GAME, A PAGE OR A PROGRAM',
  '- One file, whole: every function it calls written out, every name defined where it is',
  '  used. Nothing left out, shortened or "similar to above".',
  '- A game starts the way a player expects: a title or "press a key to start" - Space and',
  '  Enter start it, as well as any button - and nothing can kill the player before then.',
  '- Controls: arrow keys and WASD (Space where it fits). The arrows must not scroll the page.',
  '- Never type a map as rows of text that must line up: models miscount them, and a Pac-Man',
  '  failed five times on rows of 19, 21 and 22 characters. Build it in code - fill a grid from',
  '  a list of wall rectangles [x, y, w, h], mirror it left to right, build lanes in a loop -',
  '  and check a maze as it starts: flood-fill from the player, and throw an Error naming any',
  '  dot it cannot reach. Only a maze: a Crossy Road\'s rivers are crossed on logs, and a flood',
  '  fill that threw "unreachable grass" broke it on load. Sizes come from the data -',
  '  ROWS = MAZE.length - never a second number typed beside it.',
  '- Enemies move from the first seconds: ghosts leave their pen, cars drive. Lanes start',
  '  full - cars and logs already spread along them, not all entering from the edge, which',
  '  left a Crossy Road\'s rivers empty and uncrossable for its first seconds.',
  '- On a grid - a maze, Pac-Man, Snake, Tetris - things move from tile centre to tile centre:',
  '  keep the tile it is leaving, the tile it is entering and a progress from 0 to 1; at 1 it',
  '  is on the new tile, takes any turn pressed early, and checks the wall one tile ahead.',
  '  Never test a moving x for landing exactly on a centre - it never does - and never nudge a',
  '  free x and y against walls: those Pac-Men stuck at the first corner, or never moved.',
  '- Every speed and timer is per second, times the time since the last frame - capped, so a',
  '  tab coming back does not jump everything. requestAnimationFrame gives milliseconds:',
  '  divide by 1000 once, in one place. One unit for every position and size - tiles or',
  '  pixels, never both: a car 30 wide meant pixels, was drawn in tiles, and covered the road.',
  '- Game over shows the score, and Space, Enter or a button starts a new game that really',
  '  runs: every piece of state reset, and one game loop that never stops - a loop stopped',
  '  at game over and never started again is the commonest bug there is.',
  '- Outside the browser, write for what is installed here, and give the exact command that',
  '  runs it. Wumpy\'s check of your code says what is installed; so does `pip show <package>`.',
  '  `python -c` never runs here: it runs code.',
  '- Fair to play: enemies a little slower than the player (ghosts about 85% of Pac-Man\'s',
  '  speed), not all hunting the same way, and a second\'s grace after a life is lost - a',
  '  Pac-Man lost all three lives in four seconds. Every timer in seconds, never in frames.',
  '- What kills the player does, every frame, in one test in one unit: a car hits when it is',
  '  in the player\'s lane - the same row, not the row next to it - and its x span overlaps the',
  '  player\'s. Wumpy stands the player in a road and waits for a car: one that drives through',
  '  sends it back. Twice a Crossy Road was "fixed" and its cars still drove through the chicken.',
  '- To change a file already saved: read it whole with a plain `cat <its path>`, then send',
  '  wumpy-edit blocks - they change the file you read. Never type the whole file out again.',
  '- Asked to change how it plays - dying when hit, the spacing, a speed - change exactly that,',
  '  and show it: a probe that sets the case up and reads the result, e.g. `show: (player.row =',
  '  cars[0].row, player.col = Math.round(cars[0].x), 1)`, `wait: 300`, `show: gameOver`.',
  '- Overlays - title, game over - are a centred column: heading, score, how to play again.',
  '- Compact: a basic game is 300 to 600 lines. Short comments; no essays in the code.',
  '- When Wumpy says something does not work, look before you change code: a',
  `  ${BT}wumpy-probe block plays your page and reads values back - lines \`press: Space, ArrowLeft\`,`,
  '  `wait: 500`, `show: pacman` or `show: canMove(3, 4, \'left\')` - any expression on the page.',
  '- Before you report, play it in your head: the first second, each key once, losing, the',
  '  restart, and the score.'
]

/** Whether a brief is for something built: a game, a page, an app, a program. */
export function isBuild(brief: string): boolean {
  return /\b(games?|play(?:able)?|html|web ?page|website|app|application|program|canvas|tetris|snake|pac-?man|pong|breakout|platformer|crossy|frogger|asteroids|invaders|minesweeper|sudoku|chess|2048|flappy|python|c\+\+|cpp|javascript)\b|c\+\+/i.test(brief)
}

/**
 * The instructions, built for the machine and the mode it runs under.
 *
 * Written for the two ways a delegated agent fails. It wanders - asks
 * questions nobody can answer, summarises work instead of handing it over,
 * leaves "..." where the content should be - and it bluffs, reporting a
 * fact about the machine it never checked to a chat that will repeat it as
 * true. Both are worse than not having an agent: the chat waited a minute
 * for something it cannot use.
 */
export function agentPrompt(world: AgentWorld): string {
  const shell = world.platform === 'win32' ? 'PowerShell' : 'bash'
  const runs =
    world.mode === 'manual'
      ? 'Under their settings nothing runs without them clicking, so every command comes back NOT RUN: work from the brief.'
      : 'Only commands that read run; one that would change anything comes back NOT RUN.'
  const search = !world.search
    ? 'Web search is off.'
    : world.mode === 'manual'
      ? 'Web search needs their click too, so it comes back NOT RUN.'
      : `To search the web: a ${BT}wumpy-search block with a short query; the results come back to you.`
  return [
    'You are a background agent for Wumpy, the assistant on this person’s computer. Wumpy',
    'handed you one task: the brief in the first message. You work alone - you cannot ask',
    'the user or Wumpy anything, and nobody sees your work until your report. So finish',
    'the task, then report.',
    '',
    'Most tasks need no tools at all: writing, drafting, reviewing, working something out. For',
    'those, your first reply IS your report. Use a tool only for a fact you need from this',
    'computer or the web.',
    '',
    `Now: ${world.now}. Commands run in ${shell} from ${world.cwd}.`,
    '',
    'HOW YOU WORK',
    '- Each reply is either ONE tool block or your final report - nothing else. You have no',
    '  function tools: a tool use is a fenced block in your reply, written exactly as below.',
    `- To look at the computer: a ${BT}wumpy-run block, first line a # saying why, then one`,
    `  ${shell} command. Its output comes back to you. ${runs}`,
    '  If something comes back NOT RUN, do not try a variant of it: say in your report what',
    '  should be run and why.',
    `- ${search}`,
    '- Wumpy tests what you build, before anyone reviews it: a web page in your report is',
    '  loaded out of sight and played - arrow keys held, the game lost, restarted - and a',
    '  program in Python, C, C++, JavaScript or bash is compiled or parsed, never run. What',
    '  breaks comes back to you to fix. To test a page part-way, send a',
    `  ${BT}wumpy-check-page block holding the whole page. None of it proves the logic: that is yours.`,
    `- You have at most ${world.steps} tool uses. Spend them on what the task needs; a task`,
    '  that needs none - writing, reviewing, working something out - needs none.',
    '- Never ask for the same thing twice: its answer is already above.',
    `- To fix the file in your last report - Wumpy keeps it; it is on no disk - send ${BT}wumpy-edit blocks:`,
    '  a line FIND:, the lines to change copied exactly from the file (enough to be in one place),',
    '  a line REPLACE:, the new lines; as many pairs as it needs. Wumpy makes the changes and tests',
    `  the result as your new report. To see the file as it is now, a ${BT}wumpy-show block.`,
    '- You change nothing on this computer: you look, and you hand back. To write something - a',
    '  script, a document, a file - is to give that text, in full, in your report; Wumpy saves',
    '  it. A brief that says to save a file at a path means: hand back its whole content, and',
    '  Wumpy saves it there - never try to write it yourself. For a change, give the exact',
    '  command, and Wumpy runs it. Never say you saved, created or ran anything that the steps',
    '  do not show.',
    '',
    'TRUTH',
    '- Every fact about this computer comes from output you were shown in this task. A check',
    '  of one thing is not a check of the next: plugged in is not charging, installed is not',
    '  running. What you could not check, you say you could not - never guess it.',
    '- Never invent a path, a version, a flag, a file or a source.',
    '- Wumpy will rely on your report. A confident wrong report is worse than an honest',
    '  "could not find out".',
    ...(world.building ? ['', ...BUILDING] : []),
    '',
    'THE REPORT',
    'When you are done, reply with no tool block, starting with the line REPORT:, then:',
    '- The deliverable itself, complete: the text, the code, the file’s content, the answer.',
    '  Never a description of work you could have included; never a placeholder or "...".',
    '- Checked: what you verified, and how - the command or the source.',
    '- Not checked: what you could not verify, and what would settle it.',
    'Compact and plain. No preamble, no offers, no questions.'
  ].join(LF)
}

/**
 * The reviewing agent: the same job /reflect's mentor does, for a report.
 * See MENTOR_PROMPT in reflect.ts, and parseReview there, which reads this.
 */
export const REVIEW_PROMPT = [
  'You are a reviewing agent. Another background agent was given the brief below and',
  'produced the report below, after the steps listed. Review it as a careful senior',
  'colleague would:',
  '',
  '- Does the report deliver what the brief asked - all of it, not a nearby easier thing?',
  '- Is every claim about the computer backed by output in the steps? A claim with nothing',
  '  behind it is a REVISE. So is reasoning from one reading to a different fact.',
  '- Is it correct: facts, code that would run, commands that exist? Is anything left as a',
  '  placeholder? For a page, game or script, run it in your head: every name defined where',
  '  used, speeds per second scaled by frame time, every part the brief asked for really there.',
  '  A page loaded with errors left in is a REVISE.',
  '- For anything built - a game, a page, an app: list EVERY requirement in the brief and find',
  '  the code that does each. One with no code doing it is a REVISE, by name. Then play it in',
  '  your head: the first second (can it kill the player before a key is pressed?), each',
  '  control once, losing, and the restart - is every piece of state reset, and does the game',
  '  loop run again? A game stuck at its start, or frozen after a restart, is not a game.',
  "- Wumpy's own test of the page or program is in the steps: what it shows is fact.",
  '- A REVISE about logic works one case through with real numbers first - "row 12 to row',
  '  11: score 0 to 1". If the numbers come out right, it is not a REVISE. If the report says',
  '  why an earlier note was wrong, check that; if it holds, drop the note - never repeat it.',
  '- Agents hand work back as text, and cannot save or run anything. A script, letter or file',
  '  given in full in the report IS delivered - also when the brief says to save it at a path:',
  '  Wumpy saves it there. Never ask for it to be saved, created or run.',
  '',
  'Do not redo the work and do not write it yourself: say what must change, concretely',
  'enough to act on. A REVISE names something WRONG or MISSING for the brief. Not taste,',
  'not something the brief did not ask for, not more checking when the output already',
  'shows the claim, and never the undoing of what an earlier review asked for. Not a bug:',
  'the game drawn behind its title or game-over overlay, as real games do. If it is',
  'right, ACCEPT - a round that changes nothing wastes the user’s time and quota.',
  '',
  'Reply in exactly this form and nothing else:',
  'VERDICT: ACCEPT',
  'NOTES: <one sentence saying why it is right>',
  'or',
  'VERDICT: REVISE',
  'NOTES:',
  '1. <what must change, and why>',
  '2. <...>'
].join(LF)

/** The most review rounds one report gets: a second REVISE is the last. */
export const REVIEW_ROUNDS = 2
/**
 * A built thing gets a third: its reviewer is shown the page, and the last
 * revision of a Pac-Man - the one that fixed the maze it had seen - went
 * out with nobody looking at it.
 */
export const BUILD_REVIEW_ROUNDS = 3

/* -------------------------------------------------- reading a reply */

export type Step =
  | { kind: 'run'; command: string; why: string; shell: 'powershell' | 'bash' | 'cmd' }
  | { kind: 'search'; query: string; why: string }
  /* A whole web page to load out of sight: see main/pagecheck.ts. */
  | { kind: 'page'; html: string; why: string }
  /* Changes to the file in its last report: see applyEdits. */
  | { kind: 'edit'; edits: Array<{ find: string; replace: string }> }
  /* The file in its last report, as it is now. */
  | { kind: 'show' }
  /* Its page played as it says, and values read back: see probePage. */
  | { kind: 'probe'; script: string }
  | { kind: 'report'; text: string }

/**
 * What an agent's reply asks for: a command, a search, or - with no tool
 * block at all - its report. The first tool block wins; one at a time is
 * the rule, and a reply that proposes three has only been heard once.
 */
export function stepOf(reply: string, platform: AgentWorld['platform']): Step {
  const edits = editsIn(reply)
  if (edits.length) return { kind: 'edit', edits }
  if (/^\s{0,3}`{3,}[ \t]*wumpy-show\b/m.test(reply)) return { kind: 'show' }
  const probe = new RegExp(`^\\s{0,3}${BT}[ \\t]*wumpy-probe\\b[^\\n]*\\n([\\s\\S]*?)^\\s{0,3}${BT}`, 'm').exec(reply)
  if (probe) return { kind: 'probe', script: probe[1] }
  /* A page to test: everything up to the block's own closing fence, which
     is the last one - a page's script may hold backticks of its own. */
  const page = new RegExp(`${BT}[ \\t]*(?:\\n[ \\t]*)?wumpy-check-page\\b[^\\n]*\\n([\\s\\S]*)${BT}`).exec(reply)
  if (page) {
    const lines = page[1].split(LF)
    const why = lines[0]?.trim().startsWith('#') ? lines.shift()!.trim().replace(/^#+\s*/, '') : ''
    const html = lines.join(LF).trim()
    if (/<(?:!doctype|html|body|script|canvas)/i.test(html)) return { kind: 'page', html, why }
  }
  /* "``` wumpy-run", with a space, is a command too: an agent wrote exactly
     that twice, live, and its "report" went back as an unrun command. */
  const block = new RegExp(`${BT}[ \\t]*(?:\\n[ \\t]*)?(wumpy-run(?:-bash|-cmd)?|wumpy-search)\\b[^\\n]*\\n([\\s\\S]*?)${BT}`).exec(reply)
  if (block) {
    const lines = block[2].split(LF)
    const whyLine = lines.find((l) => l.trim().startsWith('#'))
    const why = whyLine ? whyLine.trim().replace(/^#+\s*/, '') : ''
    const body = lines
      .filter((l) => !l.trim().startsWith('#'))
      .join(LF)
      .trim()
    if (block[1] === 'wumpy-search') {
      if (body) return { kind: 'search', query: body.split(LF)[0].trim(), why }
    } else if (body) {
      const shell = block[1] === 'wumpy-run-cmd' ? 'cmd' : platform === 'win32' ? 'powershell' : 'bash'
      return { kind: 'run', command: body, why, shell }
    }
  }
  /*
   * The model's own tool-call markup, which some write whatever they are
   * told: `<tool_call><function=wumpy-search><parameter=query>...`. A
   * research agent wrote three of these, live, ran nothing, and its "report"
   * was the markup - which the chat then answered from its own knowledge as
   * though it were the agent's findings. The first call is the step.
   */
  const call = /<function=(wumpy-run(?:-bash|-cmd)?|wumpy-search)>([\s\S]*?)(?:<\/function>|$)/.exec(reply)
  if (call) {
    const params = new Map<string, string>()
    for (const p of call[2].matchAll(/<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g)) params.set(p[1].toLowerCase(), p[2].trim())
    const why = params.get('why') ?? params.get('reason') ?? ''
    if (call[1] === 'wumpy-search') {
      const query = params.get('query') ?? params.get('q') ?? [...params.values()][0] ?? ''
      if (query) return { kind: 'search', query: query.split(LF)[0].trim(), why }
    } else {
      const command = params.get('command') ?? params.get('cmd') ?? [...params.values()][0] ?? ''
      if (command) {
        const shell = call[1] === 'wumpy-run-cmd' ? 'cmd' : platform === 'win32' ? 'powershell' : 'bash'
        return { kind: 'run', command, why, shell }
      }
    }
  }
  const text = reply.replace(/^\s*REPORT:\s*/i, '').trim()
  return { kind: 'report', text }
}

/**
 * The file in a report, as it is to be saved: a whole web page, or else the
 * longest fenced block of anything - and where it sits in the report. Null
 * when there is none worth saving.
 */
export function fileSpan(report: string): { text: string; kind: string; start: number; end: number } | null {
  const page = /(<!doctype html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i.exec(report)
  if (page && /<script|<canvas|<body/i.test(page[1])) return { text: `${page[1]}${LF}`, kind: 'a web page', start: page.index, end: page.index + page[1].length }
  const lines = report.split(LF)
  const offsets: number[] = []
  let at = 0
  for (const l of lines) {
    offsets.push(at)
    at += l.length + 1
  }
  let best: { text: string; kind: string; start: number; end: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,})[ \t]*([\w+#.-]*)/.exec(lines[i])
    if (!open) continue
    let j = i + 1
    while (j < lines.length && !new RegExp(`^\\s{0,3}${open[1]}\x60*\\s*$`).test(lines[j])) j++
    const body = lines.slice(i + 1, j)
    /* Its own tool blocks are never the file, nor what is left of an edit
       whose block closed early: a malformed edit once was saved as a game. */
    if (/^wumpy-/i.test(open[2]) || body.some((l) => /^\s*(?:<{3,}\s*)?(?:FIND|SEARCH|REPLACE)\s*[:>]?\s*$|^\s*>{3,}\s*REPLACE\s*$/i.test(l))) {
      i = j
      continue
    }
    if (body.length >= 6 && (!best || body.join(LF).length > best.text.length)) {
      best = { text: `${body.join(LF)}${LF}`, kind: open[2] ? `${open[2]} code` : 'a file', start: offsets[i + 1], end: offsets[i + 1] + body.join(LF).length }
    }
    i = j
  }
  return best
}

export function fileIn(report: string): { text: string; kind: string } | null {
  const span = fileSpan(report)
  return span ? { text: span.text, kind: span.kind } : null
}

/**
 * The report as the chat is shown it when the file in it is saved by
 * reference: the file itself left out. Shown it, the chat wrote `from:` and
 * then typed all nine thousand characters out anyway, for nothing.
 */
export function withoutFile(report: string, id: string): string {
  const span = fileSpan(report)
  if (!span) return report
  const lines = span.text.split(LF).length - 1
  return `${report.slice(0, span.start)}[${span.kind}, ${lines} lines - not shown here; it is saved as written with from: ${id}]${report.slice(span.end)}`
}

/**
 * The changes in a reply's wumpy-edit blocks: FIND: then the lines as they
 * are, REPLACE: then the lines as they should be, as many pairs as it needs.
 *
 * A fix used to mean writing the whole file again, and a Pac-Man is twenty
 * thousand characters - three cut-off replies stitched together - so every
 * revision could break what the last one fixed, and did: its maze check
 * failed on five versions running.
 */
export function editsIn(reply: string): Array<{ find: string; replace: string }> {
  const out: Array<{ find: string; replace: string }> = []
  const lines = reply.split(LF)
  const MARK_FIND = /^\s*(?:<{3,}\s*)?(?:FIND|SEARCH)\s*[:>]?\s*$/i
  const MARK_REPLACE = /^\s*REPLACE(?:\s+WITH)?\s*[:>]?\s*$/i
  const MARK_MID = /^\s*={5,}\s*$/
  const MARK_END = /^\s*>{3,}\s*REPLACE\s*$/i
  const FENCE = /^\s{0,3}`{3,}[\w+#.-]*\s*$/
  const nextReal = (from: number): string => {
    for (let k = from; k < lines.length; k++) if (lines[k].trim()) return lines[k]
    return ''
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s{0,3}`{3,}[ \t]*wumpy-edit\b/.test(lines[i])) continue
    let mode: 'none' | 'find' | 'replace' = 'none'
    let find: string[] = []
    let replace: string[] = []
    const flush = (): void => {
      if (mode === 'replace' && find.join('').trim()) out.push({ find: find.join(LF), replace: replace.join(LF) })
      find = []
      replace = []
    }
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      /* FIND: and REPLACE:, as asked - or FIND>, SEARCH:, and the
         <<<<<<< SEARCH / ======= / >>>>>>> REPLACE that models know. */
      if (MARK_FIND.test(l)) {
        flush()
        mode = 'find'
        continue
      }
      if (mode === 'find' && (MARK_REPLACE.test(l) || MARK_MID.test(l))) {
        mode = 'replace'
        continue
      }
      if (mode === 'replace' && MARK_END.test(l)) {
        flush()
        mode = 'none'
        continue
      }
      /*
       * A fence inside the block: the code of a FIND or REPLACE wrapped in
       * its own, which closed a C++ Snake's edit early - and the pieces
       * left over were taken for its file. A fence that opens a section,
       * or closes one with another marker after it, is skipped; any other
       * closes the block.
       */
      if (FENCE.test(l)) {
        const after = nextReal(j + 1)
        const opensSection = /`{3,}[\w+#.-]+/.test(l) || ((mode === 'find' || mode === 'replace') && !find.length && !replace.length)
        if (opensSection || MARK_FIND.test(after) || MARK_REPLACE.test(after) || MARK_MID.test(after)) continue
        break
      }
      if (mode === 'find') find.push(l)
      else if (mode === 'replace') replace.push(l)
    }
    flush()
    i = j
  }
  return out
}

/**
 * The edits, made to a file - all of them or none. Each FIND must match one
 * place: exactly, or else line for line with the spaces at each end ignored,
 * since a model copying code back tends to lose indentation.
 */
export function applyEdits(file: string, edits: ReadonlyArray<{ find: string; replace: string }>): { ok: true; text: string } | { ok: false; why: string } {
  let text = file
  for (const [n, e] of edits.entries()) {
    const first = e.find.split(LF).find((l) => l.trim())?.trim().slice(0, 80) ?? ''
    const exact = text.split(e.find).length - 1
    if (exact === 1) {
      text = text.replace(e.find, () => e.replace)
      continue
    }
    if (exact > 1) return { ok: false, why: `FIND number ${n + 1} (starting "${first}") is in your file ${exact} times: give more lines around it, so it is in one place only.` }
    const have = text.split(LF)
    const want = e.find.split(LF).map((l) => l.trim())
    while (want.length && !want[0]) want.shift()
    while (want.length && !want[want.length - 1]) want.pop()
    const at: number[] = []
    for (let i = 0; i + want.length <= have.length; i++) {
      if (want.every((w, k) => have[i + k].trim() === w)) at.push(i)
    }
    /* Or with blank lines and runs of spaces not counted: a model copying
       its own lines back drops a blank line or a double space. */
    if (!at.length) {
      const squash = (l: string): string => l.replace(/\s+/g, ' ').trim()
      const wanted = want.map(squash).filter(Boolean)
      const lines = have.map((l, i) => [squash(l), i] as const).filter(([l]) => l)
      const found: Array<[number, number]> = []
      for (let i = 0; wanted.length && i + wanted.length <= lines.length; i++) {
        if (wanted.every((w, k) => lines[i + k][0] === w)) found.push([lines[i][1], lines[i + wanted.length - 1][1]])
      }
      if (found.length === 1) {
        text = [...have.slice(0, found[0][0]), ...e.replace.split(LF), ...have.slice(found[0][1] + 1)].join(LF)
        continue
      }
    }
    if (at.length !== 1) {
      return {
        ok: false,
        why: at.length
          ? `FIND number ${n + 1} (starting "${first}") matches ${at.length} places: give more lines around it.`
          : `FIND number ${n + 1} (starting "${first}") is not in your file. Copy the lines exactly as they are now${nearest(text, first)}`
      }
    }
    text = [...have.slice(0, at[0]), ...e.replace.split(LF), ...have.slice(at[0] + want.length)].join(LF)
  }
  return { ok: true, text }
}

/**
 * Where in the file a missed FIND most likely meant, as it reads now -
 * earlier edits change the file under a later one - so the next try can
 * copy it rather than remember it.
 */
function nearest(file: string, line: string): string {
  const words = (t: string): string[] => t.toLowerCase().match(/[a-z_$][\w$]*|\d+/g) ?? []
  const want = new Set(words(line))
  if (!want.size) return ':'
  const lines = file.split(LF)
  let best = -1
  let score = 0
  lines.forEach((l, i) => {
    const got = words(l)
    const hit = got.filter((w) => want.has(w)).length / Math.max(want.size, got.length)
    if (hit > score) {
      score = hit
      best = i
    }
  })
  if (best < 0 || score < 0.3) return ' - nothing in it is close.'
  const from = Math.max(0, best - 4)
  return `. The closest place, as it reads now:${LF}${lines.slice(from, best + 5).join(LF)}`
}

/** The report with its file swapped for a new one: an edited version. */
/**
 * The last file it read whole, with a plain `cat <path>`: what its edits
 * change when it has written no file of its own. Asked to make a Crossy
 * Road's cars kill, an agent read the game, sent three edits - "There is no
 * file in a report of yours to change yet" - and then typed out all 34,000
 * characters of it again, cut off twice on the way.
 */
export function fileRead(records: ReadonlyArray<{ kind: string; what: string; outcome: string }>): { path: string; text: string } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.kind !== 'run') continue
    const m = /^\s*(?:cat|type|Get-Content|gc)\s+("[^"]+"|'[^']+'|[^\s|;&<>]+)\s*$/i.exec(r.what)
    if (!m) continue
    const out = /^Exit code 0\b[^\n]*\nOutput:\n([\s\S]*?)(?:\nErrors:\n[\s\S]*)?$/.exec(r.outcome)
    if (!out || /…output truncated…/.test(out[1])) continue
    return { path: m[1].replace(/^["']|["']$/g, ''), text: `${out[1]}${LF}` }
  }
  return null
}

const FENCE_LANG: Record<string, string> = { html: 'html', htm: 'html', py: 'python', cpp: 'cpp', cc: 'cpp', c: 'c', js: 'javascript', sh: 'bash', ts: 'typescript', css: 'css' }

/** A report holding a file it read and changed, as if it had written it out. */
export function reportOfRead(path: string, text: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const lang = FENCE_LANG[(name.split('.').pop() ?? '').toLowerCase()] ?? ''
  return `REPORT:${LF}${name}, with the changes asked for.${LF}${BT}${lang}${LF}${text.replace(/\n$/, '')}${LF}${BT}`
}

export function withFile(report: string, file: string): string {
  const span = fileSpan(report)
  if (!span) return report
  return `${report.slice(0, span.start)}${file.replace(/\n$/, '')}${report.slice(span.end)}`
}

/**
 * A continuation joined to what it continues. A reply cut off by the length
 * limit and asked to carry on "from the very next character" often starts a
 * little before it - the half line again, or the code fence reopened - and
 * a game stitched from three such pieces came back "missing ) after
 * argument list" at a seam, version after version. The overlap goes.
 */
export function joinContinuation(before: string, after: string): string {
  let next = after
  /* A fence reopened at the top, when the cut fell inside one. */
  const open = (before.match(/^\s{0,3}`{3,}/gm) ?? []).length % 2 === 1
  if (open) next = next.replace(/^\s*`{3,}[\w-]*[ \t]*\n/, '')
  /* The longest tail of what came before that it starts by repeating. */
  const max = Math.min(400, before.length, next.length)
  for (let n = max; n >= 12; n--) {
    if (before.endsWith(next.slice(0, n))) return before + next.slice(n)
  }
  /* Or the whole cut line again, from its start. */
  const lastLine = before.slice(before.lastIndexOf('\n') + 1)
  if (lastLine.trim().length >= 8 && next.startsWith(lastLine)) return before + next.slice(lastLine.length)
  return before + next
}

/**
 * A reply that saves an agent's file by reference, without any long block
 * of code written beside it. Told not to, the chat still followed its
 * `from:` save with a game of its own invention in an html block - fifteen
 * seconds spent, and shown to the user as though it were what was saved.
 */
/**
 * The file a piece of work is about, by its name: "pacman.html". An agent
 * is named after it on its card, so every agent that works on the same
 * file shows the same name - "Agent 1" built Pac-Man and "Agent 2" restyled
 * it, and the user asked why the same job had changed hands.
 */
export function fileNamed(text: string): string | undefined {
  const m = /(?:^|[\s"'`(\/\\])(\w[\w.-]*\.(?:html?|py|cpp|cc|cxx|c|h|hpp|js|mjs|ts|tsx|jsx|css|sh|rs|go|java|rb|lua|cs|kt|swift))(?=$|[\s"'`),.;:!?])/i.exec(text)
  return m?.[1]
}

/** Words that say what is made, not which thing: "Build a Pac-Man game". */
const PLAIN_WORDS = new Set(
  'a an the and or of in on for to with from into one single build rebuild make remake write rewrite create fix fixed again retry try new another full complete working game html page file program code script version same that this its it so'.split(' ')
)

/** Two titles about the same thing: a retry of "Build a Pac-Man game" is "Pac-Man again, player moving". */
export function sameWork(a: string, b: string): boolean {
  const words = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9+#-]+/).filter((w) => w.length > 2 && !PLAIN_WORDS.has(w))
  const theirs = new Set(words(a))
  return words(b).some((w) => theirs.has(w))
}

export function withoutRetypedCode(text: string): string {
  if (!/`{3,}[ \t]*wumpy-write[\s\S]*?\n[ \t]*from:\s*agent-\d+/i.test(text)) return text
  return text.replace(/^([ \t]{0,3})(`{3,})[ \t]*(html?|javascript|js|typescript|ts|python|py|cpp|c\+\+|c|css|bash|sh)?[ \t]*\n([\s\S]*?)\n[ \t]{0,3}\2`*[ \t]*$/gm, (whole, indent: string, _fence, _tag, body: string) =>
    body.split(LF).length >= 12 ? `${indent}_(code left out: the file saved is the agent's, as it wrote it)_` : whole
  )
}

/**
 * A write the chat made of a built thing in the same reply that hands it to
 * an agent: not written. Told to delegate, it did both - the agent's tested
 * file comes back to be saved, and the chat's untested one would only be
 * overwritten by it, after being played as though it were the answer.
 */
export function heldForAgent(reply: string, write: { path: string | null; from?: string | null }): boolean {
  if (write.from || !write.path) return false
  if (!/^\s{0,3}`{3,}[ \t]*wumpy-agent\b/m.test(reply)) return false
  return /\.(?:html?|py|pyw|cpp|cc|cxx|c|js|mjs|ts|sh)$/i.test(write.path.trim())
}

/** Output handed back to the agent, trimmed to what a model can use. */
export function clip(text: string, max = 6000): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.7))
  const tail = text.slice(-Math.floor(max * 0.25))
  return `${head}${LF}... (${text.length - head.length - tail.length} characters left out) ...${LF}${tail}`
}

/** One step, as the reviewer and the log see it. */
export interface StepRecord {
  kind: 'run' | 'search' | 'page' | 'code'
  what: string
  why: string
  outcome: string
}

/** What the reviewer is shown. */
export function reviewInput(
  brief: string,
  steps: readonly StepRecord[],
  report: string,
  /* Earlier reviews' notes, which the report has acted on. */
  before: readonly string[] = []
): string {
  const done = steps.length
    ? steps
        .map((s, i) => `${i + 1}. ${s.kind === 'run' ? 'Ran' : s.kind === 'page' ? 'Loaded the page' : s.kind === 'code' ? 'Checked' : 'Searched'}: ${s.what}${LF}${clip(s.outcome, 1500)}`)
        .join(LF + LF)
    : '(none - it worked from the brief alone)'
  const earlier = before.length
    ? [`EARLIER REVIEWS, WHICH THIS REPORT HAS ACTED ON - do not ask to undo them${LF}${before.join(LF + LF)}`]
    : []
  return [`THE BRIEF${LF}${brief}`, `THE STEPS${LF}${done}`, ...earlier, `THE REPORT${LF}${report}`].join(LF + LF)
}

/* ------------------------------------------------ back to the chat */

export interface Finished {
  /** The agent's own id, "agent-7": unique across chats. */
  id?: string
  /** Its report holds a file - a page or a program - Wumpy can save as it is. */
  file?: { lines: number; kind: string }
  /** What it built never passed Wumpy's test. */
  broken?: boolean
  number: number
  title: string
  ok: boolean
  /** The report, or why there is none. */
  text: string
  tookMs: number
  /** "reviewed by agent 2: accepted", or empty. */
  review: string
  steps: number
  /**
   * What it actually ran and searched, that went through. Handed back with
   * the report so the chat can tell a finding from a guess: given a report
   * that was only an unrun command, the chat made up a df output - "325 GB
   * free" on a disk with 86.
   */
  ran?: string[]
}

function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
}

/**
 * The hand-back: one automatic message to the chat carrying every report a
 * monitor (or a lone agent) was waiting for. Said to be from the app, so the
 * model does not thank the user for writing it.
 */
export function deliveryText(done: readonly Finished[], note: string | null): string {
  const head =
    done.length === 1
      ? `Background agent ${done[0].number} has finished. This was sent by Wumpy, not typed by the user.`
      : `Background agents ${done.map((d) => d.number).join(', ')} have finished. This was sent by Wumpy, not typed by the user.`
  const parts = done.map((d) => {
    const how = [`${took(d.tookMs)}`, d.review].filter(Boolean).join(', ')
    const ran = d.ran?.length
      ? `It ran: ${d.ran.map((r) => `\x60${r.replace(/\s+/g, ' ').slice(0, 100)}\x60`).join('; ')}.`
      : 'It ran no commands and no searches.'
    /*
     * Its file is saved from the report itself, not retyped: a Crossy
     * Road that loaded clean for its agent came back from the chat's copy
     * with `fillRect is not defined` - one slip in nine thousand characters,
     * and twenty seconds spent typing them.
     */
    const file =
      d.ok && d.file && d.id && !d.broken
        ? [
            '',
            `ITS FILE (${d.file.kind}, ${d.file.lines} lines) IS READY, tested and kept by Wumpy. Whatever the report says about saving, folders or what it could not check, save it now: your whole reply is a sentence or two for the user, then this block with the path they asked for - the write makes any missing folder - and no code of your own anywhere. Never retype the file.`,
            `${BT}wumpy-write`,
            `# Save ${d.title.replace(/^(?:build|write|make|create)\s+/i, '')}`,
            'path: <the path they asked for>',
            `from: ${d.id}`,
            BT
          ].join(LF)
        : d.broken
          ? `${LF}IT DOES NOT WORK YET: every version failed Wumpy's test (below). Say so plainly, and start one more agent with the same brief plus what the test found. Never save this file, and never write one of your own instead.`
          : ''
    /* The file's save block comes last, after the report: its own words
       about folders it could not check and writes it could not make once
       talked the chat out of saving a C++ game it had been handed. */
    return d.ok
      ? `AGENT ${d.number}: ${d.title} (${how})${LF}${ran}${LF}${d.file && d.id ? withoutFile(d.text, d.id) : d.text}${file}`
      : `AGENT ${d.number}: ${d.title} - FAILED (${how}): ${d.text}`
  })
  const rule =
    'A fact about this computer in a report is only as good as what it ran, above: what no output shows, you do not know - say so, or check. Never fill it in. And if a report is not what was asked for, say so plainly: never pass off what you know yourself as what an agent found.'
  const then = note
    ? `You set a monitor for this, saying what to do now: ${note}`
    : 'Check the report like any claim, then tell the user what it means for them - briefly. A file it hands back that was meant to be saved, write with a wumpy-write block - by its `from:` line where it has one, or else exactly as given, every line.'
  return [head, ...parts, rule, then].join(LF + LF)
}

/* --------------------------------------------- what the chat is told */

/**
 * The full section, sent when agents are in play: the user talks about
 * them, one is running, or a report just came back. See needs.ts.
 */
export function agentsPrompt(slots: number): string {
  return [
    `YOU CAN WORK IN THE BACKGROUND. Up to ${slots} background agent${slots === 1 ? '' : 's'} run at once, each on`,
    'its own key, while you and the user carry on - so never say you cannot do something in the',
    'background. Start one with a wumpy-agent block: a # line naming the task, then the brief.',
    '',
    'Start one INSTEAD of doing the work in your reply when they say "in the background",',
    '"meanwhile", "while I...", or ask for several things at once (one agent each); and for long',
    'work - a long document or script, research needing several searches, a review. "At the same',
    'time" means agents, not blocks of your own; comparing or researching things is an agent\'s job,',
    'and a search of your own is for one quick fact. What a few lines or one command answers, do',
    'yourself.',
    '',
    'MAKING OR CHANGING A GAME, A WEB PAGE, AN APP OR ANY REAL PROGRAM IS ALWAYS AN AGENT\'S',
    'JOB, in any language - never write one in your own reply, not even a draft. Wumpy plays or',
    'compiles the agent\'s work, it fixes what breaks, and another agent reviews it. For a change,',
    'the brief names the file\'s full path: the agent reads it. Say it is being built; when the',
    'report comes, write the file where they asked, naming it yourself - never ask.',
    '',
    'make me a snake game in my downloads',
    'I have an agent building it - it gets played and fixed before you get it.',
    `${BT}wumpy-agent`,
    '# Build a Snake game in one HTML file',
    'Write a complete Snake game as one HTML file, no libraries: arrows and WASD, food, growing,',
    'score; it waits for a key to start; game over shows the score, and Space plays again. Hand',
    'back the whole file.',
    BT,
    '',
    'The brief is ALL it gets: it sees nothing of this chat. Put in the goal, every fact, name',
    'and detail they asked for, and exactly what to hand back. It only reads: it cannot save a',
    'file or change anything, so never ask it to - "hand back the whole file", and you write it.',
    'It never asks anyone anything. Its report comes back to you by',
    'itself: do not wait, check or poll. When you will combine several, add a wumpy-monitor block',
    '- it needs no permission - and you are woken once, when all are done, with your note:',
    '',
    `${BT}wumpy-monitor`,
    '# Merge the two drafts into one section',
    'when: all',
    BT,
    '',
    'Say in a sentence what is running. When a report arrives, check it like any claim, then',
    'pass it on.'
  ].join(LF)
}

/** The line that stands in for it on other turns. */
export function agentsStub(slots: number): string {
  return [
    `For long work that can be done alone, you can start up to ${slots} background agent${slots === 1 ? '' : 's'}`,
    `with a ${BT}wumpy-agent block; the rules arrive when agents come up.`
  ].join(LF)
}

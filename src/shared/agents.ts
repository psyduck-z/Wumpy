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
}

/** The most tool uses one agent gets before it is told to report. */
export const AGENT_STEPS = 10

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
    `- To test a web page you are writing: a ${BT}wumpy-check-page block holding the whole page.`,
    '  Wumpy loads it out of sight for 3 seconds and tells you what its console showed. Do it',
    '  before you report any page, game or app, and fix what it finds. It catches crashes, not',
    '  logic: check that yourself - every name defined where used, speeds per second scaled by',
    '  the frame time, every part the brief asked for really there.',
    `- You have at most ${world.steps} tool uses. Spend them on what the task needs; a task`,
    '  that needs none - writing, reviewing, working something out - needs none.',
    '- Never ask for the same thing twice: its answer is already above.',
    '- You change nothing on this computer: you look, and you hand back. To write something - a',
    '  script, a document, a file - is to give that text, in full, in your report; Wumpy saves',
    '  it. For a change, give the exact command, and Wumpy runs it. Never say you saved, created',
    '  or ran anything that the steps do not show.',
    '',
    'TRUTH',
    '- Every fact about this computer comes from output you were shown in this task. A check',
    '  of one thing is not a check of the next: plugged in is not charging, installed is not',
    '  running. What you could not check, you say you could not - never guess it.',
    '- Never invent a path, a version, a flag, a file or a source.',
    '- Wumpy will rely on your report. A confident wrong report is worse than an honest',
    '  "could not find out".',
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
  '  A page never loaded with wumpy-check-page, or loaded with errors left in, is a REVISE.',
  '- Agents hand work back as text. A script, letter or file given in full in the report IS',
  '  delivered; never ask for it to be saved, created or run unless the brief said so.',
  '',
  'Do not redo the work and do not write it yourself: say what must change, concretely',
  'enough to act on. A REVISE names something WRONG or MISSING for the brief. Not taste,',
  'not something the brief did not ask for, not more checking when the output already',
  'shows the claim, and never the undoing of what an earlier review asked for. If it is',
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

/* -------------------------------------------------- reading a reply */

export type Step =
  | { kind: 'run'; command: string; why: string; shell: 'powershell' | 'bash' | 'cmd' }
  | { kind: 'search'; query: string; why: string }
  /* A whole web page to load out of sight: see main/pagecheck.ts. */
  | { kind: 'page'; html: string; why: string }
  | { kind: 'report'; text: string }

/**
 * What an agent's reply asks for: a command, a search, or - with no tool
 * block at all - its report. The first tool block wins; one at a time is
 * the rule, and a reply that proposes three has only been heard once.
 */
export function stepOf(reply: string, platform: AgentWorld['platform']): Step {
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

/** Output handed back to the agent, trimmed to what a model can use. */
export function clip(text: string, max = 6000): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.7))
  const tail = text.slice(-Math.floor(max * 0.25))
  return `${head}${LF}... (${text.length - head.length - tail.length} characters left out) ...${LF}${tail}`
}

/** One step, as the reviewer and the log see it. */
export interface StepRecord {
  kind: 'run' | 'search' | 'page'
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
        .map((s, i) => `${i + 1}. ${s.kind === 'run' ? 'Ran' : s.kind === 'page' ? 'Loaded the page' : 'Searched'}: ${s.what}${LF}${clip(s.outcome, 1500)}`)
        .join(LF + LF)
    : '(none - it worked from the brief alone)'
  const earlier = before.length
    ? [`EARLIER REVIEWS, WHICH THIS REPORT HAS ACTED ON - do not ask to undo them${LF}${before.join(LF + LF)}`]
    : []
  return [`THE BRIEF${LF}${brief}`, `THE STEPS${LF}${done}`, ...earlier, `THE REPORT${LF}${report}`].join(LF + LF)
}

/* ------------------------------------------------ back to the chat */

export interface Finished {
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
    return d.ok
      ? `AGENT ${d.number}: ${d.title} (${how})${LF}${ran}${LF}${d.text}`
      : `AGENT ${d.number}: ${d.title} - FAILED (${how}): ${d.text}`
  })
  const rule =
    'A fact about this computer in a report is only as good as what it ran, above: what no output shows, you do not know - say so, or check. Never fill it in. And if a report is not what was asked for, say so plainly: never pass off what you know yourself as what an agent found.'
  const then = note
    ? `You set a monitor for this, saying what to do now: ${note}`
    : 'Check the report like any claim, then tell the user what it means for them - briefly. A file it hands back that was meant to be saved, write with a wumpy-write block exactly as given, every line.'
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
    'and a search of your own is for one quick fact. Building something - a game, a page, an app',
    '- is an agent\'s job too: it can load a page to see what breaks, and another agent reviews',
    'the code before it reaches you. What a few lines or one command answers, do yourself.',
    '',
    'while I am in this meeting, draft a cover letter for that junior developer job',
    'I have an agent drafting it - you will have it when it is done.',
    `${BT}wumpy-agent`,
    '# Draft a cover letter for the junior developer job',
    'Draft a one-page cover letter from <their name> for the junior developer job at <the company>,',
    'drawing on <the skills they named>. Hand back the whole letter.',
    BT,
    '',
    'The brief is ALL it gets: it sees nothing of this chat. Put in the goal, every fact, name,',
    'path and output it needs, and exactly what to hand back. It only reads: it hands back text and',
    'commands, and any change - a file written, a command run - is yours, the usual way. It never',
    'asks anyone anything. Its report comes back to you by',
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

import {
  AGENT_STEPS,
  BUILD_REVIEW_ROUNDS,
  REVIEW_PROMPT,
  REVIEW_ROUNDS,
  agentPrompt,
  applyEdits,
  clip,
  fileIn,
  fileNamed,
  fileRead,
  reportOfRead,
  sameWork,
  fileSpan,
  isBuild,
  joinContinuation,
  withFile,
  deliveryText,
  reviewInput,
  stepOf,
  type AgentAsk,
  type AgentWorld,
  type Finished,
  type MonitorAsk,
  type StepRecord
} from '@shared/agents'
import { codeIn, LANG_NAME, type CodeLang } from '@shared/codecheck'
import { parseReview } from '@shared/reflect'
import type { AgentDelivery, AgentView, MonitorView } from '@shared/types'
import type { WireMessage } from '@shared/cloud'

/**
 * Background agents, running: the hands for @shared/agents.
 *
 * Each agent holds one key for as long as it works, so the chat and the
 * voice are never queued behind it; one that cannot get a key waits in line
 * rather than share the chat's. It talks to its model a turn at a time, runs
 * what the user's approval mode would run without a click and nothing more,
 * and when it reports, a fresh reviewer - the same key, none of the agent's
 * context - reads the report against the brief and the steps. A REVISE goes
 * back to the agent as notes; an ACCEPT, or the second round, ends it.
 *
 * Reports are handed to the chat that asked, as one automatic message, once
 * whatever monitor is waiting on them is satisfied. They wait here until
 * that chat is open and idle (see the panel's useAgents), so switching chats
 * does not lose one. They do not survive Wumpy restarting; nor does an agent.
 */

type Shell = 'powershell' | 'bash' | 'cmd'

export interface TurnResult {
  text: string | null
  /** Stopped at the length limit mid-reply. */
  cutOff?: boolean
  status: number
  error?: string
  promptTokens: number
  completionTokens: number
  ms: number
}

export interface AgentDeps {
  /** The model agents use: the one the chat is on. Null when none can answer. */
  model(): string | null
  /** How many may work at once, from the key count (agentSlots). */
  slots(): number
  hold(model: string): number | null
  release(model: string, key: number): void
  keyReady(model: string, key: number): boolean
  turn(
    model: string,
    messages: WireMessage[],
    key: number,
    opts: { numPredict: number; timeoutMs: number; signal?: AbortSignal }
  ): Promise<TurnResult>
  world(): Omit<AgentWorld, 'steps'>
  /** Runs a command if the approval mode runs it without a click. */
  run(command: string, shell: Shell): Promise<{ ran: boolean; ok: boolean; output: string }>
  search(query: string): Promise<{ ran: boolean; ok: boolean; output: string }>
  /** Loads a page out of sight; ok when its console showed no errors. A
      picture of it mid-game, as a data URL, when one was taken. */
  checkPage(html: string): Promise<{ ran: boolean; ok: boolean; output: string; shots?: string[] }>
  /** Whether the model can be shown a picture. */
  sees(model: string): boolean
  /** Compiles or parses a program without running it: see main/codecheck.ts. */
  checkCode(code: string, lang: CodeLang): Promise<{ ran: boolean; ok: boolean; output: string; missing: string[] }>
  /** Plays a terminal program in a sandbox for a few seconds; null where it cannot. */
  runCode(code: string, lang: CodeLang): Promise<{ ok: boolean; output: string } | null>
  /** Plays a page as asked and reads values back: see main/pagecheck.ts. */
  probePage(html: string, script: string): Promise<{ ran: boolean; ok: boolean; output: string }>
  /** The list changed: tell the panel. */
  changed(): void
  /** A report is ready for a chat. */
  ready(delivery: AgentDelivery): void
  /** One request spent, for /usage. */
  spent(r: { model: string; ok: boolean; limited: boolean; promptTokens: number; completionTokens: number; ms: number }): void
  log(line: string): void
}

interface Agent extends AgentView {
  brief: string
  heldKey: number | null
  controller: AbortController
  records: StepRecord[]
  finished?: Finished
  /** Why it failed, when it did. */
  why?: string
  /** Every version it built failed Wumpy's test. */
  stillBroken?: boolean
  /** Its last reply ran past the length it may have, by this many characters. */
  tooLong?: number
  /** The agent before it whose build never worked, that it tries again. */
  follows?: string
}

interface Monitor extends MonitorView {
  /** The agents it watches, by id. */
  ids: string[]
}

/** A command that writes a file: an agent trying to save its work itself. */
const SAVES_FILE = /(?:^|[^<>2&])>\s*[~\/\w$"']|\btee\b|open\([^)]*['"][wa]['"]|write_text|Set-Content|Out-File|New-Item|\bcp\s|\bmv\s|\bmkdir\b|\btouch\s|<<\s*['"]?EOF/i

/** A command that prints a file: its output is kept whole, up to a point. */
const READS_FILE = /^\s*(?:cat|Get-Content|gc|type|bat|nl|head|tail|sed\s+-n)\b/i

/** How long a single turn may take before it counts as stalled. */
const TURN_TIMEOUT_MS = 240_000
/**
 * Room for a long deliverable: a file, a section, a full answer. It was
 * 4,096, and a whole game came back cut off mid-line three times running;
 * past this, a cut-off reply is asked to carry on (see ask).
 */
const AGENT_TOKENS = 8192
/**
 * A build's turns get twice that, so a whole game fits in one reply more
 * often: every cut-off is a seam, and seams are where the code broke. A
 * model that refuses it gets the usual, and is remembered.
 */
const BUILD_TOKENS = 16384
const refusedBig = new Set<string>()
/** How many times a reply cut off by the length limit is asked to carry on. */
const CARRY_ON = 3
const REVIEW_TOKENS = 900
/** How often a queued agent looks for a free key. */
const QUEUE_LOOK_MS = 5000
/** The longest an agent waits for its key to stop resting. */
const KEY_WAIT_MS = 120_000
/** The longest one waits in line for a key at all. */
const QUEUE_GIVE_UP_MS = 10 * 60_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const LF = String.fromCharCode(10)
const BT3 = String.fromCharCode(96).repeat(3)

/** Said with the picture of the page the reviewer is shown. */
const SEEN_NOTE = [
  'THE PICTURE is the page as Wumpy saw it after playing it for a few seconds. Look at it as a',
  'player would: is it the thing the brief asked for, and is it drawn right? Look at where each',
  'thing is: a car on the grass, a log off the river, a ghost inside a wall, a player off the',
  'board - something drawn a row out from where it belongs. Walls or paths out of line, shapes',
  'overlapping that should not, things missing, text cut off or laid out sideways, a blank or',
  'black screen - each is a REVISE, said plainly. Judge only what it shows.'
].join(LF)

export class Agents {
  private agents: Agent[] = []
  private monitors: Monitor[] = []
  private pending: AgentDelivery[] = []
  private serial = 0
  private queueTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: AgentDeps) {}

  /** Working or waiting to: what holds the ranker back. */
  active(): number {
    return this.agents.filter((a) => a.status === 'queued' || a.status === 'working' || a.status === 'reviewing').length
  }

  list(): { agents: AgentView[]; monitors: MonitorView[] } {
    return { agents: this.agents.map(view), monitors: this.monitors.map(monitorView) }
  }

  /** The file an agent handed back, exactly as it wrote it: see fileIn. */
  fileOf(id: string): string | null {
    const agent = this.agents.find((a) => a.id === id)
    return agent?.status === 'done' && agent.report && !agent.stillBroken ? (fileIn(agent.report)?.text ?? null) : null
  }

  /**
   * The panel saved an agent's file: its card takes the file's name, and so
   * does the broken try it followed, which had none until now.
   */
  saved(id: string, path: string): void {
    const name = path.split(/[\\/]/).pop()
    if (!name) return
    const seen = new Set<string>()
    for (let a = this.agents.find((x) => x.id === id); a && !seen.has(a.id); a = this.agents.find((x) => x.id === a!.follows)) {
      seen.add(a.id)
      if (a.id === id || !a.thing) a.thing = name
    }
    this.deps.changed()
  }

  forChat(chatId: string): AgentView[] {
    return this.agents.filter((a) => a.chatId === chatId).map(view)
  }

  pendingFor(chatId: string): AgentDelivery[] {
    return this.pending.filter((d) => d.chatId === chatId)
  }

  delivered(id: string): void {
    this.pending = this.pending.filter((d) => d.id !== id)
  }

  /**
   * Starts the agents a finished answer asked for. Asking twice for the same
   * block - a re-render, a panel reload - returns the agent already there.
   */
  start(chatId: string, messageId: string, asks: readonly AgentAsk[]): AgentView[] {
    const out: AgentView[] = []
    asks.forEach((ask, index) => {
      const key = `${messageId}:${index}`
      const had = this.agents.find((a) => a.key === key)
      if (had) {
        out.push(view(had))
        return
      }
      const mine = this.agents.filter((a) => a.chatId === chatId)
      /* Named after its file where the brief names one; a fresh try at a
         build that never worked is the same thing, under the same name. */
      const named = fileNamed(`${ask.title}\n${ask.brief}`)
      const last = mine[mine.length - 1]
      const follows = !named && last?.stillBroken && sameWork(last.title, ask.title) ? last : undefined
      const agent: Agent = {
        id: `agent-${++this.serial}`,
        key,
        chatId,
        number: mine.length + 1,
        thing: named ?? follows?.thing,
        follows: follows?.id,
        title: ask.title,
        brief: ask.brief,
        status: 'queued',
        doing: 'waiting for a free key',
        steps: [],
        startedAt: Date.now(),
        model: this.deps.model() ?? '',
        review: '',
        heldKey: null,
        controller: new AbortController(),
        records: []
      }
      this.agents.push(agent)
      this.deps.log(`[agents] ${agent.number} "${agent.title}" asked for in chat ${chatId}`)
      out.push(view(agent))
    })
    this.pump()
    this.deps.changed()
    return out
  }

  /** Sets the monitors a finished answer asked for. They need no permission. */
  monitor(chatId: string, messageId: string, asks: readonly MonitorAsk[]): MonitorView[] {
    const out: MonitorView[] = []
    asks.forEach((ask, index) => {
      const key = `${messageId}:monitor:${index}`
      const had = this.monitors.find((m) => m.key === key)
      if (had) {
        out.push(monitorView(had))
        return
      }
      const mine = this.agents.filter((a) => a.chatId === chatId)
      const named =
        ask.agents === 'all' ? mine.filter((a) => !ended(a)) : mine.filter((a) => (ask.agents as number[]).includes(a.number))
      /* Only those still working: one that already reported has been
         handed back once, and a monitor must not hand it back again. */
      const watched = named.filter((a) => !ended(a))
      const monitor: Monitor = {
        id: `monitor-${++this.serial}`,
        key,
        chatId,
        note: ask.note,
        when: ask.when,
        agents: named.map((a) => a.number),
        ids: watched.map((a) => a.id),
        fired: false
      }
      this.monitors.push(monitor)
      this.deps.log(`[agents] monitor on ${monitor.agents.join(', ') || 'nothing'} (${monitor.when}): ${monitor.note}`)
      out.push(monitorView(monitor))
      /* Nothing to watch, or everything it watches is already over: it
         fires now, so the chat is not left waiting on nothing. */
      if (!watched.length) {
        monitor.fired = true
        this.deliver(
          chatId,
          [],
          monitor.note,
          named.length
            ? `Agent${named.length === 1 ? '' : 's'} ${named.map((a) => a.number).join(', ')} had already finished; their reports came back earlier in this chat.`
            : 'There are no background agents working in this chat for that monitor to watch.'
        )
      }
    })
    this.deps.changed()
    return out
  }

  stop(id: string): void {
    const agent = this.agents.find((a) => a.id === id)
    if (!agent || ended(agent)) return
    agent.controller.abort()
    this.end(agent, 'stopped', 'stopped by the user')
  }

  /** Everything, for quitting. */
  stopAll(): void {
    for (const agent of this.agents) if (!ended(agent)) agent.controller.abort()
  }

  /* ------------------------------------------------------------ running */

  /** Starts whoever is queued, while there are slots and keys. */
  private pump(): void {
    const working = (): number => this.agents.filter((a) => a.status === 'working' || a.status === 'reviewing').length
    /* No slots at all - keys removed, or a one-key provider chosen - or a
       wait past reason: those in line are told, rather than holding the
       ranker and every monitor on them for ever. */
    for (const agent of this.agents.filter((a) => a.status === 'queued')) {
      if (this.deps.slots() === 0) this.end(agent, 'failed', 'there are no keys to spare: background agents need two that work')
      else if (Date.now() - agent.startedAt > QUEUE_GIVE_UP_MS) this.end(agent, 'failed', 'no key came free in ten minutes')
    }
    for (const agent of this.agents.filter((a) => a.status === 'queued')) {
      if (working() >= this.deps.slots()) break
      const model = agent.model || this.deps.model()
      if (!model) {
        this.end(agent, 'failed', 'no model can answer: add a key')
        continue
      }
      agent.model = model
      const key = this.deps.hold(model)
      if (key === null) break
      agent.heldKey = key
      agent.status = 'working'
      agent.doing = 'reading the brief'
      this.deps.log(`[agents] ${agent.number} "${agent.title}" started on key ${key + 1} with ${model}`)
      void this.work(agent).catch((err) => this.end(agent, 'failed', `it broke: ${String(err)}`))
    }
    if (this.queueTimer) clearTimeout(this.queueTimer)
    this.queueTimer = null
    if (this.agents.some((a) => a.status === 'queued')) {
      this.queueTimer = setTimeout(() => this.pump(), QUEUE_LOOK_MS)
    }
    this.deps.changed()
  }

  private async work(agent: Agent): Promise<void> {
    const world = this.deps.world()
    const messages: WireMessage[] = [
      { role: 'system', content: agentPrompt({ ...world, steps: AGENT_STEPS, building: isBuild(agent.brief) }) },
      { role: 'user', content: agent.brief }
    ]
    let used = 0
    let rounds = 0
    let lastCall = false
    /* What it has asked for already, so asking again is caught. */
    const tried = new Map<string, number>()
    let repeats = 0
    /* Its last report, kept: an agent told to finish that asks for a tool
       instead still has the answer it gave before. */
    let lastReport = ''
    /* What earlier reviews asked for, so a later one does not undo it. */
    const asked: string[] = []
    let sendBacks = 0
    /* The last report whose page loaded clean, with a player that moved -
       or whose program compiled. */
    let lastGood = ''
    /* Wumpy's test failed the file in lastReport. */
    let lastBroken = false
    let missingSaid = false
    let badEdits = 0
    let shows = 0
    /* The page as it looked mid-game, and at game over, for a reviewer
       that can see. */
    let shots: string[] | undefined
    for (;;) {
      if (agent.controller.signal.aborted) return
      agent.doing = used ? `thinking, after ${used} step${used === 1 ? '' : 's'}` : 'working on it'
      this.deps.changed()
      leaner(messages)
      const big = isBuild(agent.brief) && !refusedBig.has(agent.model)
      let reply = await this.ask(agent, messages, big ? BUILD_TOKENS : AGENT_TOKENS)
      if (reply === null && big && agent.why?.includes('(400)') && !agent.controller.signal.aborted) {
        refusedBig.add(agent.model)
        agent.why = undefined
        this.deps.log(`[agents] ${agent.number}: ${agent.model} refused ${BUILD_TOKENS} tokens; asking for ${AGENT_TOKENS}`)
        reply = await this.ask(agent, messages, AGENT_TOKENS)
      }
      if (agent.controller.signal.aborted) return
      if (reply === null) {
        this.end(agent, 'failed', agent.why ?? 'the model did not answer')
        return
      }
      /* Far too long to be a basic game, and cut off besides: said, and
         written again smaller - a Pac-Man ran to seventy-eight thousand. */
      if (agent.tooLong) {
        const long = agent.tooLong
        agent.tooLong = undefined
        badEdits++
        messages.push({ role: 'assistant', content: reply.slice(0, 4000) })
        messages.push({
          role: 'user',
          content: `NOT USED: that reply ran past ${long} characters and was cut off unfinished. A basic game is 300 to 600 lines - about 20,000 characters. Write it again, whole and smaller: short comments, no long explanations, nothing extra.`
        })
        if (badEdits >= 4) {
          this.end(agent, 'failed', 'its replies kept running far too long to finish')
          return
        }
        continue
      }
      /* A reply of many tool blocks is no step at all: a Pac-Man agent
         ended its last replies with dozens of `echo "Done"` blocks. */
      const blocks = reply.match(/^\s{0,3}`{3,}[ \t]*wumpy-(?:run|search|check-page)/gm)?.length ?? 0
      if (blocks > 3) {
        badEdits++
        messages.push({ role: 'assistant', content: reply.slice(0, 2000) })
        messages.push({ role: 'user', content: `NOT USED: that reply held ${blocks} tool blocks. One tool block per reply, or your REPORT.` })
        if (badEdits >= 4) {
          this.end(agent, 'failed', 'its replies kept running on')
          return
        }
        continue
      }
      messages.push({ role: 'assistant', content: reply })
      let step = stepOf(reply, world.platform)
      /* Told to report and asked for another tool anyway: the report it
         gave before, if it gave one - an agent that found the answer at
         its first step and was then asked for more must not end with
         nothing - or else what it wrote around the block. */
      const giveUp = (): void => {
        const text = reply.replace(/```[\s\S]*?```/g, '').replace(/^\s*REPORT:\s*/i, '').trim()
        /* Never one Wumpy's test failed, as if it worked: the last that
           passed, or else said plainly that none did. */
        if (lastReport && lastBroken && lastGood) {
          agent.review = `${agent.review ? `${agent.review}; ` : ''}its last version broke, so the one before it stands`
          this.finishReport(agent, lastGood, true)
        } else if (lastReport && lastBroken) {
          const last = [...agent.records].reverse().find((r) => /before review/.test(r.why))?.outcome ?? ''
          agent.review = `${agent.review ? `${agent.review}; ` : ''}it still breaks when Wumpy tests it`
          agent.stillBroken = true
          this.finishReport(agent, `${lastReport}${LF}${LF}WUMPY'S TEST OF THIS FINAL VERSION FOUND IT STILL BROKEN - do not tell the user it works:${LF}${clip(last, 1500)}`, true)
        } else if (lastReport) {
          agent.review = `${agent.review}; its earlier report stands, as it could not finish the changes asked for`.replace(/^; /, '')
          this.finishReport(agent, lastReport, true)
        } else this.finishReport(agent, text || 'It ran out of steps before it could report.', text.length > 0)
      }
      /*
       * A look inside its page, or at its file, once it was told to report:
       * the end of it. Those two went round the step check below, and an
       * agent out of steps probed its page the same way 28 times in seven
       * minutes, a request on the user's keys each time, never to finish.
       */
      if (lastCall && (step.kind === 'probe' || step.kind === 'show')) {
        giveUp()
        return
      }

      /* Its page, played as it asks, values read back - a tool use. */
      if (step.kind === 'probe') {
        const file = lastReport ? fileIn(lastReport) : null
        if (!file || file.kind !== 'a web page') {
          messages.push({ role: 'user', content: 'There is no page in a report of yours yet to probe: give your whole REPORT first.' })
          continue
        }
        /* The same probe twice is answered from the first time. */
        const said = `probe: ${step.script.replace(/\s+/g, ' ').trim()}`
        const first = tried.get(said)
        if (first !== undefined) {
          repeats++
          if (repeats >= 2) lastCall = true
          messages.push({
            role: 'user',
            content:
              `NOT RUN: you asked for exactly this probe at step ${first}, and its answer is above. ` +
              (lastCall ? 'Write your REPORT now with what you have.' : 'Change something, probe something else, or write your REPORT.')
          })
          continue
        }
        used++
        tried.set(said, used)
        agent.doing = 'looking inside its page'
        this.deps.changed()
        const r = await this.deps.probePage(file.text, step.script)
        if (agent.controller.signal.aborted) return
        agent.records.push({ kind: 'page', what: 'probed its page', why: 'to see why', outcome: r.output })
        agent.steps.push({ kind: 'page', what: 'looked inside its page', ok: r.ran })
        this.deps.log(`[agents] ${agent.number} probed its page: ${r.output.replace(/\s+/g, ' ').slice(0, 200)}`)
        if (used >= AGENT_STEPS) lastCall = true
        messages.push({
          role: 'user',
          content: `${clip(r.output, 6000)}${lastCall ? `${LF}${LF}That was your last tool use. Write your REPORT now with what you have, and say what is not checked.` : ''}`
        })
        continue
      }
      /* Its file as it is now, after edits: it is on no disk, and agents
         went looking for it with cat and find. */
      if (step.kind === 'show') {
        const file = lastReport ? fileIn(lastReport) : null
        shows++
        messages.push({
          role: 'user',
          content: file
            ? `Your file as it is now (${file.text.split(LF).length - 1} lines):${LF}${BT3}${LF}${clip(file.text, 60_000)}${BT3}`
            : 'There is no file in a report of yours yet.'
        })
        if (shows > 3) lastCall = true
        if (lastCall) messages.push({ role: 'user', content: 'That was your last look. Write your REPORT now.' })
        continue
      }
      /* Edits to the file in its last report: made, and the result goes on
         as its report. A FIND that matches nowhere goes back to it. */
      if (step.kind === 'edit') {
        const file = lastReport ? fileIn(lastReport) : null
        /* Or the file it read, when it has written none: a change asked for
           to a file already saved. */
        const read = file ? null : fileRead(agent.records)
        const base = file?.text ?? read?.text
        const made = base
          ? applyEdits(base, step.edits)
          : ({ ok: false, why: 'There is no file to change yet: read it first with a plain `cat <its path>`, or give your whole REPORT.' } as const)
        this.deps.log(`[agents] ${agent.number} sent ${step.edits.length} edit(s): ${made.ok ? 'made' : made.why.slice(0, 120)}`)
        if (!made.ok) {
          badEdits++
          messages.push({
            role: 'user',
            content: `NOT MADE: ${made.why}${badEdits >= 3 ? ' Give your whole REPORT again instead.' : ' Nothing was changed.'}`
          })
          continue
        }
        agent.steps.push({ kind: 'code', what: `changed ${step.edits.length} place${step.edits.length === 1 ? '' : 's'} in its file`, ok: true })
        step = { kind: 'report', text: file ? withFile(lastReport, made.text) : reportOfRead(read!.path, made.text) }
      }

      if (step.kind !== 'report') {
        if (lastCall) {
          giveUp()
          return
        }
        if (used >= AGENT_STEPS) {
          lastCall = true
          messages.push({
            role: 'user',
            content: 'That was your last tool use. Write your REPORT now with what you have, and say what is not checked.'
          })
          continue
        }
        /*
         * The same thing twice is not run twice. Observed: an agent asked to
         * write a script asked ten times to list a file that a refusal had
         * already answered, spent every step on it, and then reported having
         * saved the script. A repeat is answered from the first time, and a
         * second repeat ends the asking.
         */
        const said = (step.kind === 'run' ? step.command : step.kind === 'page' ? `page: ${step.html}` : `search: ${step.query}`)
          .replace(/\s+/g, ' ')
          .trim()
        const first = tried.get(said)
        if (first !== undefined) {
          repeats++
          if (repeats >= 2) lastCall = true
          messages.push({
            role: 'user',
            content:
              `NOT RUN: you asked for exactly this at step ${first}, and its answer is above. ` +
              (lastCall ? 'Write your REPORT now with what you have.' : 'Use what you have, try something different, or write your REPORT.')
          })
          continue
        }
        used++
        tried.set(said, used)
        const outcome = await this.act(agent, step)
        if (agent.controller.signal.aborted) return
        messages.push({ role: 'user', content: outcome })
        continue
      }

      if (step.text.length < 2) {
        this.end(agent, 'failed', 'it reported nothing')
        return
      }
      /* A build's report without its file - an edit it got wrong, or a
         note about one - when the last report had it: the file is not
         thrown away for it. A Pac-Man's last word was a broken edit
         block, and that block was saved as pacman.html. */
      const before = isBuild(agent.brief) && lastReport ? fileIn(lastReport) : null
      const now = before ? fileIn(step.text) : null
      /* Or only a piece of it: a Pac-Man's last report held 1,300
         characters of a 15,000-character game, and that was saved. */
      const partial = Boolean(before && now && ((before.kind === 'a web page' && now.kind !== 'a web page') || now.text.length < before.text.length * 0.4))
      if (before && (!now || partial)) {
        badEdits++
        messages.push({
          role: 'user',
          content: partial
            ? `Your report has only part of the file - ${now!.text.length} characters, where your last had ${before.text.length}. Send the change as wumpy-edit blocks, or your whole REPORT with the whole file.`
            : /wumpy-edit/.test(step.text)
              ? 'NOT MADE: that wumpy-edit block has no FIND: and REPLACE: lines Wumpy could read, so nothing was changed. Send it again in that form, or your whole REPORT with the whole file.'
              : 'Your report has no file in it. Send the change as wumpy-edit blocks, or your whole REPORT with the whole file.'
        })
        if (badEdits >= 4) {
          this.finishReport(agent, lastGood || lastReport, true)
          return
        }
        continue
      }
      lastReport = step.text
      lastBroken = false
      /*
       * A page in the report is loaded before anyone reviews it - every
       * report, not the first few: a revision made for a reviewer once
       * undid the fix that had made the player move, and nobody loaded
       * it. Errors go back to the agent, three times at most. The last
       * version that loaded clean and moved is kept, and stands if a
       * later one breaks.
       */
      const page = pageIn(step.text)
      const program = page ? null : codeIn(step.text)
      let broken = false
      if (page) {
        agent.doing = 'loading the page it wrote'
        this.deps.changed()
        const r = await this.deps.checkPage(page)
        if (agent.controller.signal.aborted) return
        agent.records.push({ kind: 'page', what: `the page in its report (${page.length} characters)`, why: 'checked before review', outcome: r.output })
        agent.steps.push({ kind: 'page', what: r.ok ? 'its page loaded: no errors' : 'its page loaded with errors', ok: r.ran && r.ok })
        this.deps.log(`[agents] ${agent.number} its page: ${r.output.replace(/\s+/g, ' ').slice(0, 160)}`)
        broken = r.ran && !r.ok
        lastBroken = broken
        shots = r.shots
        if (!broken && r.ran) lastGood = step.text
        if (broken && sendBacks < 3) {
          sendBacks++
          messages.push({
            role: 'user',
            content: `Wumpy loaded the page in your report. ${r.output}\n\n${/did not move|did not start again|never got anywhere|nothing started/.test(r.output) ? 'Look before you change anything: a wumpy-probe block plays your page and reads values back (press: ArrowLeft, wait: 500, show: <the player>, show: <what your movement code checks>). Then fix' : 'Fix'} the cause - read your code, do not guess - with wumpy-edit blocks, or your whole REPORT again.`
          })
          continue
        }
      } else if (program) {
        /*
         * A program in another language, compiled or parsed the same way:
         * "test its other languages too, not just HTML". Never run - it
         * would run with all the user's rights - but a name used and never
         * defined, a missing header, a module that is not installed, all
         * show without running it.
         */
        const name = LANG_NAME[program.lang]
        agent.doing = `checking the ${name} it wrote`
        this.deps.changed()
        const r = await this.deps.checkCode(program.code, program.lang)
        if (agent.controller.signal.aborted) return
        agent.records.push({ kind: 'code', what: `the ${name} in its report (${program.code.split('\n').length} lines)`, why: 'checked before review', outcome: r.output })
        agent.steps.push({
          kind: 'code',
          what: !r.ran ? `its ${name} could not be checked here` : r.ok ? `its ${name} checked: no errors` : `its ${name} had errors`,
          ok: r.ran && r.ok
        })
        this.deps.log(`[agents] ${agent.number} its ${name}: ${r.output.replace(/\s+/g, ' ').slice(0, 200)}`)
        broken = r.ran && !r.ok
        lastBroken = broken
        /* Compiled clean, and a game: played, in a sandbox, where it can be. */
        if (!broken && r.ran && isBuild(agent.brief)) {
          agent.doing = `playing the ${name} it wrote`
          this.deps.changed()
          const played = await this.deps.runCode(program.code, program.lang)
          if (agent.controller.signal.aborted) return
          if (played) {
            agent.records.push({ kind: 'code', what: `the ${name} in its report, run`, why: 'played before review', outcome: played.output })
            agent.steps.push({ kind: 'code', what: played.ok ? `its ${name} ran: still going after 6 seconds` : `its ${name} ran: it broke`, ok: played.ok })
            this.deps.log(`[agents] ${agent.number} its ${name}, run: ${played.output.replace(/\s+/g, ' ').slice(0, 200)}`)
            if (!played.ok) {
              broken = true
              lastBroken = true
              if (sendBacks < 3) {
                sendBacks++
                messages.push({
                  role: 'user',
                  content: `Wumpy compiled the ${name} in your report, then ran it out of sight and pressed keys.\n${played.output}\n\nFix the cause - read your code, do not guess - with wumpy-edit blocks, or your whole REPORT again.`
                })
                continue
              }
            }
          }
        }
        if (!broken && r.ran) lastGood = step.text
        if (broken && sendBacks < 3) {
          sendBacks++
          messages.push({
            role: 'user',
            content: `Wumpy checked the ${name} in your report.\n${r.output}\n\nFix the cause - read your code, do not guess - with wumpy-edit blocks, or your whole REPORT again.`
          })
          continue
        }
        /* Something it imports is not here: said once, so it can choose
           something that is - or keep what the brief asked for and say
           how to install it. */
        if (!broken && r.missing.length && !missingSaid) {
          missingSaid = true
          messages.push({
            role: 'user',
            content: `Wumpy checked the ${name} in your report.\n${r.output}\n\nGive your whole REPORT again: on what is installed here, or with the brief's library and the exact command that installs it.`
          })
          continue
        }
      }
      /* Out of chances with a broken page or program: the last that worked. */
      if (broken && lastGood) {
        agent.review = `${agent.review ? `${agent.review}; ` : ''}its last version broke, so the one before it stands`
        this.finishReport(agent, lastGood, true)
        return
      }
      /* None ever worked: it goes back saying so, with what Wumpy saw, so
         the chat does not call it done. A Pac-Man whose maze check failed
         on every version was handed over as if it played. */
      if (broken && sendBacks >= 3) {
        const last = agent.records[agent.records.length - 1]?.outcome ?? ''
        agent.review = `${agent.review ? `${agent.review}; ` : ''}it still breaks when Wumpy tests it`
        agent.stillBroken = true
        this.finishReport(agent, `${step.text}${LF}${LF}WUMPY'S TEST OF THIS FINAL VERSION FOUND IT STILL BROKEN - do not tell the user it works:${LF}${clip(last, 1500)}`, true)
        return
      }
      /* Feedback from another agent before the report goes anywhere: up to
         REVIEW_ROUNDS reviews, and the answer to the last one stands. */
      if (rounds < (isBuild(agent.brief) ? BUILD_REVIEW_ROUNDS : REVIEW_ROUNDS)) {
        agent.status = 'reviewing'
        agent.doing = 'being reviewed by another agent'
        this.deps.changed()
        const review = await this.review(agent, step.text, asked, page ? shots : undefined)
        if (agent.controller.signal.aborted) return
        agent.status = 'working'
        if (review?.verdict === 'revise') {
          asked.push(review.notes)
          rounds++
          agent.review = `sent back ${rounds === 1 ? 'once' : `${rounds} times`} by its reviewer`
          this.deps.log(`[agents] ${agent.number} sent back by its reviewer: ${review.notes.replace(/\s+/g, ' ').slice(0, 200)}`)
          messages.push({
            role: 'user',
            content: [
              'Another agent reviewed your report against the brief and the steps, and found:',
              review.notes,
              '',
              `Fix what it found - with tool uses if you need them (${Math.max(0, AGENT_STEPS - used)} left) - with wumpy-edit blocks, or your whole REPORT again.`,
              /* A reviewer that misread the brief once had a working hop
                 slowed to eight seconds a tile, and the agent obliged. */
              'A note can be wrong. If one contradicts the brief or misreads your code, do not follow it: say why, in one line, in your report.'
            ].join('\n')
          })
          continue
        }
        if (review?.verdict === 'accept') agent.review = rounds ? `${agent.review}, then accepted` : 'accepted on review'
      } else {
        agent.review = `${agent.review}; the last revision was not reviewed again`
      }
      this.finishReport(agent, step.text, true)
      return
    }
  }

  /** One model turn on the agent's key, waiting out a rest and retrying a hiccup. */
  private async ask(
    agent: Agent,
    messages: WireMessage[],
    numPredict: number
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (agent.controller.signal.aborted || agent.heldKey === null) return null
      let waited = 0
      while (!this.deps.keyReady(agent.model, agent.heldKey) && waited < KEY_WAIT_MS) {
        if (agent.controller.signal.aborted) return null
        agent.doing = 'waiting for its key to come back'
        this.deps.changed()
        await sleep(5000)
        waited += 5000
      }
      const r = await this.guarded(agent, messages, numPredict)
      this.deps.spent({
        model: agent.model,
        ok: Boolean(r.text),
        limited: r.status === 429,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        ms: r.ms
      })
      if (r.text?.trim() && r.cutOff) return this.carryOn(agent, messages, numPredict, r.text)
      if (r.text?.trim()) return r.text.trim()
      if (agent.controller.signal.aborted) return null
      this.deps.log(`[agents] ${agent.number} turn failed: ${r.status || 'no answer'} ${r.error ?? ''}`.trim())
      if (r.status === 401 || r.status === 403) {
        /* The key was refused for good: another, if one is free. */
        this.deps.release(agent.model, agent.heldKey)
        agent.heldKey = this.deps.hold(agent.model)
        if (agent.heldKey === null) {
          agent.why = 'its key was refused and no other was free'
          return null
        }
        continue
      }
      if (r.status === 429) continue
      if (r.status === 400 || r.status === 404 || r.status === 410) {
        agent.why = `the model refused the request (${r.status})`
        return null
      }
      await sleep(3000 * (attempt + 1))
    }
    agent.why = 'the model did not answer, four times'
    return null
  }

  /**
   * One model turn that cannot hang: its own timeout is the first line, and
   * this the last. An agent building a Tetris waited eighteen minutes on a
   * turn that should have given up after four, and said nothing meanwhile.
   */
  private async guarded(agent: Agent, messages: WireMessage[], numPredict: number): Promise<TurnResult> {
    const started = Date.now()
    const turn = this.deps.turn(agent.model, messages, agent.heldKey!, { numPredict, timeoutMs: TURN_TIMEOUT_MS, signal: agent.controller.signal })
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<TurnResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ text: null, status: 0, error: 'no answer within the turn limit', promptTokens: 0, completionTokens: 0, ms: Date.now() - started }),
        TURN_TIMEOUT_MS + 30_000
      )
    })
    const r = await Promise.race([turn, watchdog])
    clearTimeout(timer)
    const took = Date.now() - started
    if (took > 120_000) this.deps.log(`[agents] ${agent.number}'s turn took ${Math.round(took / 1000)}s (${r.completionTokens} tokens out${r.error ? `, ${r.error}` : ''})`)
    return r
  }

  /**
   * A reply the length limit cut off, finished: asked to carry on from
   * exactly where it stopped, and joined, up to CARRY_ON times.
   */
  private async carryOn(
    agent: Agent,
    messages: WireMessage[],
    numPredict: number,
    begun: string
  ): Promise<string> {
    let text = begun
    /* Already past what a basic game needs, at its first cut: not carried
       on at all, and what it was writing goes to the log. */
    if (text.length > 45_000) {
      this.deps.log(`[agents] ${agent.number}'s reply was cut off at ${text.length} characters, past any basic game: not carrying on. It ended: ${JSON.stringify(text.slice(-300))}`)
      agent.tooLong = text.length
      return text.trim()
    }
    for (let i = 0; i < CARRY_ON && agent.heldKey !== null && !agent.controller.signal.aborted; i++) {
      this.deps.log(`[agents] ${agent.number}'s reply was cut off at ${text.length} characters: asking it to carry on`)
      const r = await this.guarded(
        agent,
        [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: 'Your reply was cut off by the length limit. Carry on from exactly where it stopped - the very next character - with no repeat, no preamble and no fence of your own unless the cut fell inside one.'
          }
        ],
        numPredict
      )
      this.deps.spent({ model: agent.model, ok: Boolean(r.text), limited: r.status === 429, promptTokens: r.promptTokens, completionTokens: r.completionTokens, ms: r.ms })
      if (!r.text) break
      text = joinContinuation(text, r.text)
      if (!r.cutOff) break
      /* A whole game is twenty thousand characters; a reply past this has
         lost its way - one restyle ran on to a hundred thousand. */
      if (text.length > 45_000) {
        this.deps.log(`[agents] ${agent.number}'s reply ran past ${text.length} characters: not carrying on`)
        agent.tooLong = text.length
        break
      }
    }
    return text.trim()
  }

  private async act(agent: Agent, step: Exclude<ReturnType<typeof stepOf>, { kind: 'report' } | { kind: 'edit' } | { kind: 'show' } | { kind: 'probe' }>): Promise<string> {
    if (step.kind === 'run') {
      agent.doing = `running: ${step.command.split('\n')[0].slice(0, 60)}`
      this.deps.changed()
      let r = await this.deps.run(step.command, step.shell)
      /* An agent trying to save its file itself: told, plainly, that it
         never does - a Snake's agent spent four steps hunting for where its
         blocked write had gone, then reported the file "never saved", and
         the chat asked the user for the source. */
      if (!r.ran && SAVES_FILE.test(step.command)) {
        r = {
          ...r,
          output: 'NOT RUN: you never save files or make folders - not with cat, tee, mkdir, python, or anything. Put the whole file in your REPORT; Wumpy saves it from there, every time, making any folder it needs. Do not mention saving or folders in your report.'
        }
      }
      /* Looking on disk for the file it is building, which is not there. */
      if (isBuild(agent.brief) && /\.(?:html?|py|cpp|cc|c|js|sh)\b|\*\./.test(step.command) && /No such file|cannot access|not found|^Exit code [1-9][\s\S]*No output/im.test(r.output)) {
        r = { ...r, output: `${r.output}\nThe file you are building is on no disk: Wumpy keeps it from your last report. A wumpy-show block shows it as it is now.` }
      }
      agent.records.push({ kind: 'run', what: step.command, why: step.why, outcome: r.output })
      agent.steps.push({ kind: 'run', what: step.command.split('\n')[0].slice(0, 120), ok: r.ran && r.ok })
      this.deps.log(`[agents] ${agent.number} ${r.ran ? 'ran' : 'was refused'}: ${step.command.replace(/\s+/g, ' ').slice(0, 120)}`)
      /* A file read whole: an agent asked to restyle a game has to see all
         of it, and 6,000 characters cut a 14,000-character Pac-Man in two
         with its middle left out. */
      return clip(r.output, READS_FILE.test(step.command) ? 60_000 : 6000)
    }
    if (step.kind === 'page') {
      agent.doing = 'loading its page to see what breaks'
      this.deps.changed()
      const r = await this.deps.checkPage(step.html)
      const what = `the page (${step.html.length} characters)`
      agent.records.push({ kind: 'page', what, why: step.why, outcome: r.output })
      agent.steps.push({ kind: 'page', what: r.ok ? 'loaded its page: no errors' : 'loaded its page: errors', ok: r.ran && r.ok })
      this.deps.log(`[agents] ${agent.number} loaded its page: ${r.output.replace(/\s+/g, ' ').slice(0, 160)}`)
      return clip(r.output, 3000)
    }
    agent.doing = `searching: ${step.query.slice(0, 60)}`
    this.deps.changed()
    const r = await this.deps.search(step.query)
    agent.records.push({ kind: 'search', what: step.query, why: step.why, outcome: r.output })
    agent.steps.push({ kind: 'search', what: step.query.slice(0, 120), ok: r.ran && r.ok })
    this.deps.log(`[agents] ${agent.number} ${r.ran ? 'searched' : 'was refused a search'}: ${step.query.slice(0, 120)}`)
    return clip(r.output, 4000)
  }

  /** A fresh reader, on the agent's own key, with none of its context. */
  private async review(
    agent: Agent,
    report: string,
    before: readonly string[],
    shots?: string[]
  ): Promise<{ verdict: 'accept' | 'revise'; notes: string } | null> {
    const text = reviewInput(agent.brief, agent.records, report, before)
    /*
     * What it looks like, to a reviewer that can see. A Pac-Man passed
     * every check - no errors, the player moved - with a maze typed in rows
     * of different lengths, walls drawn across the dots, and its ghosts
     * shut in their pen. One look shows it; no reading of the code did.
     */
    const seeing = Boolean(shots?.length) && this.deps.sees(agent.model)
    const raw = await this.ask(
      agent,
      [
        { role: 'system', content: REVIEW_PROMPT },
        seeing
          ? {
              role: 'user',
              content: [
                { type: 'text', text: `${text}${LF}${LF}${SEEN_NOTE}${shots!.length > 1 ? `${LF}The second picture is the game-over screen.` : ''}` },
                ...shots!.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
              ]
            }
          : { role: 'user', content: text }
      ],
      REVIEW_TOKENS
    )
    if (seeing) this.deps.log(`[agents] ${agent.number} its reviewer was shown the page`)
    const review = raw ? parseReview(raw) : null
    this.deps.log(`[agents] ${agent.number} reviewed: ${review ? review.verdict : 'no verdict'}`)
    return review
  }

  /* ------------------------------------------------------------ ending */

  private finishReport(agent: Agent, report: string, ok: boolean): void {
    agent.report = report
    this.end(agent, ok ? 'done' : 'failed', ok ? '' : report)
  }

  private end(agent: Agent, status: 'done' | 'failed' | 'stopped', why: string): void {
    if (ended(agent)) return
    agent.status = status
    agent.endedAt = Date.now()
    agent.doing = status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : `failed: ${why}`
    if (agent.heldKey !== null) this.deps.release(agent.model, agent.heldKey)
    agent.heldKey = null
    const file = status === 'done' ? fileIn(agent.report ?? '') : null
    agent.finished = {
      id: agent.id,
      ...(file ? { file: { lines: file.text.split(LF).length - 1, kind: file.kind } } : {}),
      ...(agent.stillBroken ? { broken: true } : {}),
      number: agent.number,
      title: agent.title,
      ok: status === 'done',
      text: status === 'done' ? (agent.report ?? '') : why,
      tookMs: agent.endedAt - agent.startedAt,
      review: agent.review,
      steps: agent.steps.length,
      ran: agent.records
        .filter((_r, i) => agent.steps[i]?.ok)
        .map((r) => (r.kind === 'run' ? r.what : r.kind === 'page' ? 'loaded its page: no errors' : r.kind === 'code' ? `checked ${r.what.replace(/^the /, 'its ').replace(/ in its report/, '')}: no errors` : `search: ${r.what}`))
    }
    this.deps.log(`[agents] ${agent.number} "${agent.title}" ${status} in ${Math.round((agent.endedAt - agent.startedAt) / 1000)}s${why ? `: ${why}` : ''}`)
    this.settle(agent)
    this.pump()
  }

  /** Hands the report on, as its monitors say. */
  private settle(agent: Agent): void {
    const covering = this.monitors.filter((m) => !m.fired && m.ids.includes(agent.id))
    const each = covering.filter((m) => m.when === 'each')
    const all = covering.filter((m) => m.when === 'all')
    if (!covering.length) {
      if (agent.status !== 'stopped') this.deliver(agent.chatId, [agent.finished!], null)
    } else if (each.length) {
      this.deliver(agent.chatId, [agent.finished!], each.map((m) => m.note).join(' Also: '))
    }
    for (const m of [...each, ...all]) {
      const theirs = m.ids.map((id) => this.agents.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a))
      if (!theirs.every(ended)) continue
      m.fired = true
      if (m.when === 'all') {
        this.deliver(m.chatId, theirs.map((a) => a.finished).filter((f): f is Finished => Boolean(f)), m.note)
      }
    }
    this.deps.changed()
  }

  private deliver(chatId: string, done: Finished[], note: string | null, instead?: string): void {
    const text = instead
      ? `${instead} This was sent by Wumpy, not typed by the user.${note ? ` Your monitor said: ${note}` : ''}`
      : deliveryText(done, note)
    const delivery: AgentDelivery = { id: `delivery-${++this.serial}`, chatId, text }
    this.pending.push(delivery)
    this.deps.ready(delivery)
  }
}

/** A whole web page in a report, if there is one. */
export function pageIn(report: string): string | null {
  const m = /(<!doctype html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i.exec(report)
  return m && /<script|<canvas|<body/i.test(m[1]) ? m[1] : null
}

function ended(a: AgentView): boolean {
  return a.status === 'done' || a.status === 'failed' || a.status === 'stopped'
}

function view(a: Agent): AgentView {
  return {
    id: a.id,
    key: a.key,
    chatId: a.chatId,
    number: a.number,
    title: a.title,
    status: a.status,
    doing: a.doing,
    steps: a.steps.map((s) => ({ ...s })),
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    model: a.model,
    review: a.review,
    report: a.report,
    thing: a.thing
  }
}

function monitorView(m: Monitor): MonitorView {
  return { id: m.id, key: m.key, chatId: m.chatId, note: m.note, when: m.when, agents: [...m.agents], fired: m.fired }
}

/**
 * Earlier versions of its file, left out of what an agent reads again:
 * only the newest stays whole. A Pac-Man agent's conversation held five
 * versions of a twenty-thousand-character game, and by the fifth its
 * replies were dozens of `echo "Done"` blocks.
 */
function leaner(messages: WireMessage[]): void {
  const replies = messages.map((m, i) => (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 8000 ? i : -1)).filter((i) => i >= 0)
  for (const i of replies.slice(0, -1)) {
    const text = messages[i].content as string
    const span = fileSpan(text)
    if (!span) continue
    messages[i] = {
      ...messages[i],
      content: `${text.slice(0, span.start)}[an earlier version of the file, ${span.text.split('\n').length - 1} lines - left out; the newest is further on]${text.slice(span.end)}`
    }
  }
}

import {
  AGENT_STEPS,
  REVIEW_PROMPT,
  REVIEW_ROUNDS,
  agentPrompt,
  clip,
  deliveryText,
  reviewInput,
  stepOf,
  type AgentAsk,
  type AgentWorld,
  type Finished,
  type MonitorAsk,
  type StepRecord
} from '@shared/agents'
import { parseReview } from '@shared/reflect'
import type { AgentDelivery, AgentView, MonitorView } from '@shared/types'

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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    key: number,
    opts: { numPredict: number; timeoutMs: number; signal?: AbortSignal }
  ): Promise<TurnResult>
  world(): Omit<AgentWorld, 'steps'>
  /** Runs a command if the approval mode runs it without a click. */
  run(command: string, shell: Shell): Promise<{ ran: boolean; ok: boolean; output: string }>
  search(query: string): Promise<{ ran: boolean; ok: boolean; output: string }>
  /** Loads a page out of sight; ok when its console showed no errors. */
  checkPage(html: string): Promise<{ ran: boolean; ok: boolean; output: string }>
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
}

interface Monitor extends MonitorView {
  /** The agents it watches, by id. */
  ids: string[]
}

/** How long a single turn may take before it counts as stalled. */
const TURN_TIMEOUT_MS = 240_000
/**
 * Room for a long deliverable: a file, a section, a full answer. It was
 * 4,096, and a whole game came back cut off mid-line three times running;
 * past this, a cut-off reply is asked to carry on (see ask).
 */
const AGENT_TOKENS = 8192
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
      const agent: Agent = {
        id: `agent-${++this.serial}`,
        key,
        chatId,
        number: this.agents.filter((a) => a.chatId === chatId).length + 1,
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
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: agentPrompt({ ...world, steps: AGENT_STEPS }) },
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
    let pageSendBacks = 0
    /* The last report whose page loaded clean, with a player that moved. */
    let lastGoodPage = ''
    for (;;) {
      if (agent.controller.signal.aborted) return
      agent.doing = used ? `thinking, after ${used} step${used === 1 ? '' : 's'}` : 'working on it'
      this.deps.changed()
      const reply = await this.ask(agent, messages, AGENT_TOKENS)
      if (agent.controller.signal.aborted) return
      if (reply === null) {
        this.end(agent, 'failed', agent.why ?? 'the model did not answer')
        return
      }
      messages.push({ role: 'assistant', content: reply })
      const step = stepOf(reply, world.platform)

      if (step.kind !== 'report') {
        if (lastCall) {
          /* Told to report and asked for another tool anyway: the report it
             gave before, if it gave one - an agent that found the answer at
             its first step and was then asked for more must not end with
             nothing - or else what it wrote around the block. */
          const text = reply.replace(/```[\s\S]*?```/g, '').replace(/^\s*REPORT:\s*/i, '').trim()
          if (lastReport) {
            agent.review = `${agent.review}; its earlier report stands, as it could not finish the changes asked for`.replace(/^; /, '')
            this.finishReport(agent, lastReport, true)
          } else this.finishReport(agent, text || 'It ran out of steps before it could report.', text.length > 0)
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
      lastReport = step.text
      /*
       * A page in the report is loaded before anyone reviews it - every
       * report, not the first few: a revision made for a reviewer once
       * undid the fix that had made the player move, and nobody loaded
       * it. Errors go back to the agent, three times at most. The last
       * version that loaded clean and moved is kept, and stands if a
       * later one breaks.
       */
      const page = pageIn(step.text)
      let pageBroken = false
      if (page) {
        agent.doing = 'loading the page it wrote'
        this.deps.changed()
        const r = await this.deps.checkPage(page)
        if (agent.controller.signal.aborted) return
        agent.records.push({ kind: 'page', what: `the page in its report (${page.length} characters)`, why: 'checked before review', outcome: r.output })
        agent.steps.push({ kind: 'page', what: r.ok ? 'its page loaded: no errors' : 'its page loaded with errors', ok: r.ran && r.ok })
        this.deps.log(`[agents] ${agent.number} its page: ${r.output.replace(/\s+/g, ' ').slice(0, 160)}`)
        pageBroken = r.ran && !r.ok
        if (!pageBroken && r.ran) lastGoodPage = step.text
        if (pageBroken && pageSendBacks < 3) {
          pageSendBacks++
          messages.push({
            role: 'user',
            content: `Wumpy loaded the page in your report. ${r.output}\n\nFix the cause - read your code, do not guess - and give your whole REPORT again.`
          })
          continue
        }
      }
      /* Out of chances with a broken page: the last one that worked. */
      if (pageBroken && lastGoodPage) {
        agent.review = `${agent.review ? `${agent.review}; ` : ''}its last version broke the page, so the one before it stands`
        this.finishReport(agent, lastGoodPage, true)
        return
      }
      /* Feedback from another agent before the report goes anywhere: up to
         REVIEW_ROUNDS reviews, and the answer to the last one stands. */
      if (rounds < REVIEW_ROUNDS) {
        agent.status = 'reviewing'
        agent.doing = 'being reviewed by another agent'
        this.deps.changed()
        const review = await this.review(agent, step.text, asked)
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
              `Fix what it found - with tool uses if you need them (${Math.max(0, AGENT_STEPS - used)} left) - and give your whole REPORT again.`,
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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
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
      const r = await this.deps.turn(agent.model, messages, agent.heldKey, {
        numPredict,
        timeoutMs: TURN_TIMEOUT_MS,
        signal: agent.controller.signal
      })
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
   * A reply the length limit cut off, finished: asked to carry on from
   * exactly where it stopped, and joined, up to CARRY_ON times.
   */
  private async carryOn(
    agent: Agent,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    numPredict: number,
    begun: string
  ): Promise<string> {
    let text = begun
    for (let i = 0; i < CARRY_ON && agent.heldKey !== null && !agent.controller.signal.aborted; i++) {
      this.deps.log(`[agents] ${agent.number}'s reply was cut off at ${text.length} characters: asking it to carry on`)
      const r = await this.deps.turn(
        agent.model,
        [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: 'Your reply was cut off by the length limit. Carry on from exactly where it stopped - the very next character - with no repeat, no preamble and no fence of your own unless the cut fell inside one.'
          }
        ],
        agent.heldKey,
        { numPredict, timeoutMs: TURN_TIMEOUT_MS, signal: agent.controller.signal }
      )
      this.deps.spent({ model: agent.model, ok: Boolean(r.text), limited: r.status === 429, promptTokens: r.promptTokens, completionTokens: r.completionTokens, ms: r.ms })
      if (!r.text) break
      text += r.text
      if (!r.cutOff) break
    }
    return text.trim()
  }

  private async act(agent: Agent, step: Exclude<ReturnType<typeof stepOf>, { kind: 'report' }>): Promise<string> {
    if (step.kind === 'run') {
      agent.doing = `running: ${step.command.split('\n')[0].slice(0, 60)}`
      this.deps.changed()
      const r = await this.deps.run(step.command, step.shell)
      agent.records.push({ kind: 'run', what: step.command, why: step.why, outcome: r.output })
      agent.steps.push({ kind: 'run', what: step.command.split('\n')[0].slice(0, 120), ok: r.ran && r.ok })
      this.deps.log(`[agents] ${agent.number} ${r.ran ? 'ran' : 'was refused'}: ${step.command.replace(/\s+/g, ' ').slice(0, 120)}`)
      return clip(r.output)
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
    before: readonly string[]
  ): Promise<{ verdict: 'accept' | 'revise'; notes: string } | null> {
    const raw = await this.ask(
      agent,
      [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: reviewInput(agent.brief, agent.records, report, before) }
      ],
      REVIEW_TOKENS
    )
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
    agent.finished = {
      number: agent.number,
      title: agent.title,
      ok: status === 'done',
      text: status === 'done' ? (agent.report ?? '') : why,
      tookMs: agent.endedAt - agent.startedAt,
      review: agent.review,
      steps: agent.steps.length,
      ran: agent.records
        .filter((_r, i) => agent.steps[i]?.ok)
        .map((r) => (r.kind === 'run' ? r.what : r.kind === 'page' ? 'loaded its page: no errors' : `search: ${r.what}`))
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
    report: a.report
  }
}

function monitorView(m: Monitor): MonitorView {
  return { id: m.id, key: m.key, chatId: m.chatId, note: m.note, when: m.when, agents: [...m.agents], fired: m.fired }
}

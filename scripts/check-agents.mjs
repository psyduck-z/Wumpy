/**
 * Background agents, monitors and the key limit tests: the pure halves, and
 * the agent runner driven against a fake model. See src/shared/agents.ts,
 * src/main/agents.ts and src/shared/limits.ts.
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(62)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

async function load(entry, name) {
  const out = join(process.cwd(), `.agents-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { '@shared': './src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const read = (path) => readFileSync(path, 'utf8')
const BT = '```'

const A = await load('src/shared/agents.ts', 'shared')
const M = await load('src/main/agents.ts', 'main')
const L = await load('src/shared/limits.ts', 'limits')
const P = await load('src/shared/pool.ts', 'pool')
const R = await load('src/shared/rotation.ts', 'rotation')
const N = await load('src/shared/needs.ts', 'needs')
const S = await load('src/shared/assistant.ts', 'assistant')

/* ------------------------------------------------------------- how many */

/* "if i have 3 keys, the max i can have 2 bg agents, and for 4, I could
   have 3, but at five... chat:bg agents would be 2:3" */
check('agents for 0..10 keys', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(A.agentSlots), [0, 0, 1, 2, 3, 3, 4, 4, 5, 5, 6])
check('five keys: two for the chat, three for agents', 5 - A.agentSlots(5), 2)
check('ten keys keep the two to three', `${10 - A.agentSlots(10)}:${A.agentSlots(10)}`, '4:6')

/* ----------------------------------------------------------- the blocks */

const answer = [
  'Two things at once.',
  '',
  `${BT}wumpy-agent`,
  '# Draft the hotkeys section',
  'Write the README section on hotkeys. Win+Shift+Z opens the panel.',
  BT,
  '',
  `${BT}wumpy-agent`,
  'Check the disk',
  'Report how full each drive is.',
  BT,
  '',
  `${BT}wumpy-agent`,
  '# Nothing in it',
  BT,
  '',
  `${BT}wumpy-monitor`,
  '# Merge the draft with the disk report',
  'when: all',
  'agents: 1, 2',
  BT
].join('\n')
check('agents asked for, briefs whole', A.agentAsks(answer), [
  { title: 'Draft the hotkeys section', brief: 'Write the README section on hotkeys. Win+Shift+Z opens the panel.' },
  /* No # line: the first line names it, and stays in the brief too. */
  { title: 'Check the disk', brief: 'Check the disk\nReport how full each drive is.' }
])
check('a monitor, with its note and agents', A.monitorAsks(answer), [{ note: 'Merge the draft with the disk report', when: 'all', agents: [1, 2] }])
check('a monitor with nothing said waits on all of them', A.monitorAsks(`${BT}wumpy-monitor\n# Tell them\n${BT}`), [
  { note: 'Tell them', when: 'all', agents: 'all' }
])
check('"when: each one finishes" is each', A.monitorAsks(`${BT}wumpy-monitor\n# Say it\nwhen: each one finishes\n${BT}`)[0].when, 'each')
check('"when: as soon as all are done" is all', A.monitorAsks(`${BT}wumpy-monitor\n# Say it\nwhen: as soon as all are done\n${BT}`)[0].when, 'all')
check('a block still being written starts nothing', A.agentAsks(`${BT}wumpy-agent\n# Half\nWrite the whole`), [])
check('the fence tags guard agent blocks', /'agent', 'monitor'/.test(read('src/shared/fences.ts')), true)

/* ------------------------------------------------------- reading a reply */

check('a command', A.stepOf(`Looking.\n${BT}wumpy-run-bash\n# How full is the disk\ndf -h /\n${BT}`, 'linux'), {
  kind: 'run',
  command: 'df -h /',
  why: 'How full is the disk',
  shell: 'bash'
})
check('on Windows, PowerShell', A.stepOf(`${BT}wumpy-run\n# Disk\nGet-PSDrive C\n${BT}`, 'win32').shell, 'powershell')
check('a search', A.stepOf(`${BT}wumpy-search\n# Current version\nelectron latest release\n${BT}`, 'linux'), {
  kind: 'search',
  query: 'electron latest release',
  why: 'Current version'
})
check('no block is the report, without its label', A.stepOf('REPORT:\nThe disk is 41% full.\nChecked: df -h /', 'linux'), {
  kind: 'report',
  text: 'The disk is 41% full.\nChecked: df -h /'
})
check('an example in a plain fence is still the report', A.stepOf(`REPORT:\n${BT}ts\nconst a = 1\n${BT}`, 'linux').kind, 'report')
check('long output is clipped, both ends kept', (() => {
  const c = A.clip('a'.repeat(5000) + 'END', 1000)
  return c.length < 1200 && c.endsWith('END') && c.includes('characters left out')
})(), true)

/* ---------------------------------------------------------- the prompts */

const linux = A.agentPrompt({ platform: 'linux', mode: 'auto', search: true, cwd: '/home/me', now: 'Thursday', steps: 10 })
check('an agent is told it works alone and must report', /cannot ask\s+the user or Wumpy anything/.test(linux) && /REPORT:/.test(linux), true)
check('and what runs under the mode it is in', /Only commands that read run/.test(linux), true)
check('manual mode: nothing runs, it works from the brief', /every command comes back NOT RUN/.test(A.agentPrompt({ platform: 'win32', mode: 'manual', search: true, cwd: 'C:', now: '', steps: 10 })), true)
check('even on accept-all, an agent only reads', /Only commands that read run/.test(A.agentPrompt({ platform: 'win32', mode: 'all', search: false, cwd: 'C:', now: '', steps: 10 })), true)
check('and main refuses it anything else, in every mode', /if \(!verdict\.auto \|\| !verdict\.readOnly\)/.test(read('src/main/index.ts')), true)
check('a bare fence with the tag on the next line is a command', A.stepOf(`${BT}\nwumpy-run\n# disk\ndf -h /\n${BT}`, 'linux'), { kind: 'run', command: 'df -h /', why: 'disk', shell: 'bash' })
check('the verify rule travels with it', /plugged in is not charging/.test(linux), true)
check('no placeholder in a deliverable', /never a placeholder/.test(linux), true)
check('it changes nothing: the text is the deliverable', /You change nothing on this computer/.test(linux) && /in full, in your report; Wumpy saves/.test(linux) && /Never say you saved, created/.test(linux), true)
check('the reviewer reads the same verdict form as /reflect', /VERDICT: ACCEPT/.test(A.REVIEW_PROMPT) && /VERDICT: REVISE/.test(A.REVIEW_PROMPT), true)

/* The chat side: the rules when agents are in play, a line otherwise, and
   nothing with one key. */
const base = { scope: 'full', search: true, screen: false, browser: false, quota: false, platform: 'linux' }
const sections = (shape) => S.promptSections(shape).join('\n')
check('one key: not a word about agents', /wumpy-agent/.test(sections({ ...base, agents: 0 })), false)
check('three keys, plain turn: the one-line stub', /up to 2 background agents/.test(sections({ ...base, agents: 2, needs: [] })) && !/YOU CAN WORK IN THE BACKGROUND/.test(sections({ ...base, agents: 2, needs: [] })), true)
check('agents in play: the rules', /YOU CAN WORK IN THE BACKGROUND\. Up to 2 background agents/.test(sections({ ...base, agents: 2, needs: ['agents'] })), true)
check('"do these in the background" brings them', N.needsFor([{ role: 'user', content: 'research these three laptops in the background' }]).includes('agents'), true)
check('a report coming back keeps them', N.needsFor([{ role: 'user', content: A.deliveryText([{ number: 1, title: 'x', ok: true, text: 'y', tookMs: 1000, review: '', steps: 0 }], null) }]).includes('agents'), true)
check('their own block keeps them', N.needsFor([{ role: 'assistant', content: `${BT}wumpy-agent\n# x\nyyyyyyyyyyyy\n${BT}` }]).includes('agents'), true)
check('"what time is it" does not', N.needsFor([{ role: 'user', content: 'what time is it' }]).includes('agents'), false)

/* What it costs. The stub goes out on every turn with two keys or more, so
   it is held to a line; the rules only when agents are in play. And a plain
   turn with the stub still fits the ceiling check-ask sets (27% of the
   window), measured the way check-ask measures it. */
const tokens = (text) => Math.ceil(text.length / 4)
check(`the stub is a line (~${tokens(A.agentsStub(2))} tokens)`, tokens(A.agentsStub(2)) <= 45, true)
/* 520: building things - games, pages, apps - joined what agents are for. */
check(`the rules stay short (~${tokens(A.agentsPrompt(2))} tokens)`, tokens(A.agentsPrompt(2)) <= 560, true)
{
  const FULL = { scope: 'full', search: true, screen: true, browser: true, quota: true }
  const plain = S.preambleTokens({ ...FULL, needs: [], agents: 2 })
  check(`a plain turn with the stub, ~${plain} tokens, under 27% of the window`, plain / S.CONTEXT_TOKENS <= 0.27, true)
}

/* ----------------------------------------------------- back to the chat */

const one = A.deliveryText([{ number: 2, title: 'Check the disk', ok: true, text: 'Root is 41% full.', tookMs: 65_000, review: 'accepted on review', steps: 1 }], null)
check('a report says it came from the app, not the user', /sent by Wumpy, not typed by the user/.test(one), true)
check('and what it was, how long, and the review', /AGENT 2: Check the disk \(65s, accepted on review\)\nIt ran no commands and no searches\.\nRoot is 41% full\./.test(one), true)
check('what it ran goes with it, and the rule against filling in', (() => {
  const t = A.deliveryText([{ number: 1, title: 'Disk', ok: true, text: 'Root: 86G free.', tookMs: 9000, review: '', steps: 1, ran: ['df -h /'] }], null)
  return /It ran: \x60df -h \/\x60\./.test(t) && /what no output shows, you do not know/.test(t)
})(), true)
check('"``` wumpy-run", with a space, is a command', A.stepOf(`${BT} wumpy-run\n# disk\ndf -h /\n${BT}`, 'linux').kind, 'run')
check('"``` wumpy-agent", with a space, is an agent', A.agentAsks(`${BT} wumpy-agent\n# T\nA brief long enough.\n${BT}`).length, 1)
check('the model\'s own tool-call markup is a step too', A.stepOf('<tool_call>\n<function=wumpy-search>\n<parameter=query>\nJoplin notes app Linux\n</parameter>\n</function>\n</tool_call>\n<tool_call><function=wumpy-search><parameter=query>Obsidian</parameter></function></tool_call>', 'linux'), {
  kind: 'search',
  query: 'Joplin notes app Linux',
  why: ''
})
check('a command in that markup is a command', A.stepOf('<tool_call><function=wumpy-run-bash><parameter=command>df -h /</parameter></function></tool_call>', 'linux').command, 'df -h /')
check('a report that is not what was asked for is said to be so', /never pass off what you know yourself as what an agent found/.test(A.deliveryText([], null)), true)
check('a page to test is a step, kept whole', (() => {
  const s = A.stepOf(`${BT}wumpy-check-page\n# does it load\n<!doctype html><script>const t = \`a\`</script>\n${BT}`, 'linux')
  return s.kind === 'page' && s.why === 'does it load' && s.html.includes('const t = `a`')
})(), true)
check('an agent is told Wumpy plays its page and compiles its program', /loaded out of sight and played/.test(linux) && /compiled or parsed, never run/.test(linux), true)
check('and told a brief to save a file means to hand it back', /A brief that says to save a file at a path means: hand back its whole content/.test(linux), true)
check('a build brief gets the building rules', A.isBuild('Write a complete Snake game as one HTML file') && /BUILDING A GAME/.test(A.agentPrompt({ platform: 'linux', mode: 'auto', search: true, cwd: '/home/u', now: 'now', steps: 10, building: true })), true)
check('and other briefs do not', A.isBuild('Draft a cover letter for the junior developer job') || /BUILDING A GAME/.test(linux), false)
check('a C++ or Python program is a build', A.isBuild('write a tetris in python') && A.isBuild('a snake game in C++ for the terminal'), true)
check('and a reviewer to check every requirement in the brief', /list EVERY requirement in the brief/.test(A.REVIEW_PROMPT) && /each\s+control once, losing, and the restart/.test(A.REVIEW_PROMPT), true)
check('and never to ask an agent to save a file the brief named', /also when the brief says to save it at a path/.test(A.REVIEW_PROMPT), true)
check('a page in a report is found for loading', [M.pageIn('REPORT:\n```html\n<!DOCTYPE html><html><body><script>x()</script></body></html>\n```'), M.pageIn('no page here')].map((x) => (x ? 'page' : null)), ['page', null])
check('the chat hands building to agents, always, in any language', /MAKING OR CHANGING A GAME, A WEB PAGE, AN APP OR ANY REAL PROGRAM IS ALWAYS AN AGENT'S\s+JOB, in any language/.test(A.agentsPrompt(2)), true)
check('and its example is a game, with no save asked of the agent', /Build a Snake game/.test(A.agentsPrompt(2)) && /it cannot save a\s+file/.test(A.agentsPrompt(2)), true)
check('a script in a bash fence is a deliverable, never run', A.stepOf(`REPORT:\n${BT}bash\nrm -rf ~/x\n${BT}`, 'linux').kind, 'report')
check('a monitor note is passed on', /You set a monitor for this, saying what to do now: merge them/.test(A.deliveryText([], 'merge them')), true)

/* ------------------------------------------------------ holding keys */

{
  const rot = new R.KeyRotation(3)
  const held = new Set([0])
  check('a held key is not chosen while another is ready', [0, 1, 2, 3].map(() => rot.next(Date.now(), 'm', held)).includes(0), false)
  check('peek takes nothing held, spends nothing', rot.peek(Date.now(), 'm', new Set([0, 1])), 2)
  rot.rest(1, Date.now() + 60_000)
  rot.rest(2, Date.now() + 60_000)
  check('and a question still gets the held key when nothing else is ready', rot.next(Date.now(), 'm', held), 0)
  check('a key resting is not ready; a key free is', [rot.ready(1), rot.ready(0)], [false, true])
}

/* -------------------------------------------- the runner, on a fake model */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function harness(script, opts = {}) {
  const log = []
  const ready = []
  const held = new Set()
  let turns = 0
  const agents = new M.Agents({
    model: () => 'fake',
    slots: () => opts.slots ?? 2,
    hold: () => {
      for (let i = 0; i < 3; i++) if (!held.has(i)) return held.add(i), i
      return null
    },
    release: (_m, k) => held.delete(k),
    keyReady: () => true,
    turn: async (_m, messages) => {
      turns++
      const reply = script(messages, turns)
      return { text: reply, status: reply ? 200 : 500, promptTokens: 1, completionTokens: 1, ms: 1 }
    },
    world: () => ({ platform: 'linux', mode: opts.mode ?? 'auto', search: true, cwd: '/home/me', now: 'now' }),
    run: async (command) =>
      opts.refuse ? { ran: false, ok: false, output: 'NOT RUN: needs a click.' } : { ran: true, ok: true, output: `Exit code 0\nOutput:\n${command} says 41%` },
    search: async () => ({ ran: true, ok: true, output: '1. A result' }),
    ...(opts.deps ?? {}),
    changed: () => {},
    ready: (d) => ready.push(d),
    spent: () => {},
    log: (l) => log.push(l)
  })
  return { agents, log, ready, held, turns: () => turns }
}
const until = async (f) => {
  for (let i = 0; i < 200 && !f(); i++) await sleep(5)
}

{
  /* A command, then a report; the reviewer accepts. */
  const h = harness((messages) => {
    const system = messages[0].content
    if (system.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: Backed by the df output.'
    const last = messages[messages.length - 1]
    if (last.role === 'user' && last.content.includes('says 41%')) return 'REPORT:\nThe disk is 41% full.\nChecked: df -h /'
    return `${BT}wumpy-run-bash\n# How full\ndf -h /\n${BT}`
  })
  const [a] = h.agents.start('chat1', 'm1', [{ title: 'Check the disk', brief: 'How full is the disk?' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('chat1')[0]
  check('an agent runs, reports and is reviewed', [v.status, v.review, v.steps.length], ['done', 'accepted on review', 1])
  check('its key is given back', h.held.size, 0)
  check('its report reaches its chat', /AGENT 1: Check the disk[\s\S]*The disk is 41% full/.test(h.ready[0]?.text ?? ''), true)
  check('starting the same block again starts nothing new', h.agents.start('chat1', 'm1', [{ title: 'Check the disk', brief: 'x' }])[0].id, a.id)
  check('and it is waiting for that chat, and only that one', [h.agents.pendingFor('chat1').length, h.agents.pendingFor('other').length], [1, 0])
  h.agents.delivered(h.ready[0].id)
  check('until it is handed over', h.agents.pendingFor('chat1').length, 0)
}

{
  /* Sent back once with notes, fixed, accepted. */
  let reviews = 0
  const h = harness((messages) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) {
      reviews++
      return reviews === 1 ? 'VERDICT: REVISE\nNOTES:\n1. Say which drive.' : 'VERDICT: ACCEPT\nNOTES: Fine now.'
    }
    const last = messages[messages.length - 1].content
    return last.includes('Say which drive') ? 'REPORT:\nThe root drive is 41% full.' : 'REPORT:\nIt is 41% full.'
  })
  h.agents.start('c', 'm', [{ title: 'Disk', brief: 'How full is the disk?' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('a REVISE goes back as notes and is acted on', [v.review, v.report], ['sent back once by its reviewer, then accepted', 'The root drive is 41% full.'])
}

{
  /* A reviewer that never accepts does not loop forever. */
  const h = harness((messages) =>
    messages[0].content.startsWith('You are a reviewing agent') ? 'VERDICT: REVISE\nNOTES:\n1. Again.' : 'REPORT:\nAn answer.'
  )
  h.agents.start('c', 'm', [{ title: 'T', brief: 'Something to do.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('two send-backs at most, then the answer stands', [v.status, v.review], ['done', 'sent back 2 times by its reviewer; its reviewer still found problems in the last version'])
  /* Three of its own, and three reviews: the last one a look at the
     version handed back, so it is not called ready unchecked. */
  check('in six model turns', h.turns(), 6)
  check('and the reviewer\'s last points go back with it', /NOT RIGHT YET[\s\S]*Again\./.test(h.ready[0]?.text ?? ''), true)
}

{
  /* Right at once, sent back for more, then stuck asking for tools: the
     right answer it gave first is what it reports - observed live, an
     agent that read "Not charging" in one step ended as "failed". */
  let reviews = 0
  const h = harness((messages, turn) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) {
      reviews++
      return 'VERDICT: REVISE\nNOTES:\n1. Say which device each line came from.'
    }
    const last = messages[messages.length - 1].content
    if (last.includes('says 41%') && !messages.some((m) => m.content.includes('Say which device'))) return 'REPORT:\nPlugged in: yes. Charging: no.'
    return `${BT}wumpy-run-bash\n# label them\nls /sys/class/power_supply\n${BT}`
  })
  h.agents.start('c', 'm', [{ title: 'Charging', brief: 'Plugged in, and charging?' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('an agent stuck after a REVISE keeps the report it had', [v.status, v.report], ['done', 'Plugged in: yes. Charging: no.'])
}

check('a later review is told what an earlier one asked for', /EARLIER REVIEWS, WHICH THIS REPORT HAS ACTED ON - do not ask to undo them\nhandle \.JPEG/.test(A.reviewInput('b', [], 'r', ['handle .JPEG'])), true)
check('and the reviewer is told a REVISE needs something wrong or missing', /A REVISE names something WRONG or MISSING/.test(A.REVIEW_PROMPT), true)

{
  /* The same command over and over: run once, then told to report. */
  const h = harness((messages) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: ok'
    const last = messages[messages.length - 1].content
    if (/Write your REPORT now/.test(last)) return 'REPORT:\nThe file is not there.'
    return `${BT}wumpy-run-bash\n# again\nls -la ~/x.sh\n${BT}`
  })
  h.agents.start('c', 'm', [{ title: 'Repeat', brief: 'Is the file there?' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('a repeated command runs once, and the agent is made to report', [v.steps.length, v.report], [1, 'The file is not there.'])
}

{
  /* One that keeps asking for tools is told to report, and is heard. */
  const h = harness((messages, turn) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: ok'
    const last = messages[messages.length - 1].content
    if (last.startsWith('That was your last tool use')) return 'REPORT:\nWhat I found so far.'
    return `${BT}wumpy-run-bash\n# again\nls /dir${turn}\n${BT}`
  })
  h.agents.start('c', 'm', [{ title: 'Loop', brief: 'Look around a lot.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('the step limit holds, and it still reports', [v.steps.length, v.report], [A.AGENT_STEPS, 'What I found so far.'])
}

{
  /* More asked for than there are slots: the rest wait their turn. */
  let release
  const gate = new Promise((r) => (release = r))
  const h = harness(() => 'REPORT:\nDone.', { slots: 1 })
  const turn = h.agents['deps'].turn
  h.agents['deps'].turn = async (...args) => {
    await gate
    return turn(...args)
  }
  h.agents.start('c', 'm', [
    { title: 'One', brief: 'The first job.' },
    { title: 'Two', brief: 'The second job.' }
  ])
  check('one slot: one works, one waits', h.agents.forChat('c').map((a) => a.status), ['working', 'queued'])
  release()
  await until(() => h.ready.length >= 2)
  check('and the second runs when the first is done', h.agents.forChat('c').map((a) => a.status), ['done', 'done'])
}

{
  /* A monitor on two agents: one hand-back, when both are done, with its note. */
  const h = harness((messages) =>
    messages[0].content.startsWith('You are a reviewing agent') ? 'VERDICT: ACCEPT\nNOTES: ok' : `REPORT:\nReport for ${messages[1].content}`
  )
  h.agents.start('c', 'm', [
    { title: 'A', brief: 'first brief' },
    { title: 'B', brief: 'second brief' }
  ])
  h.agents.monitor('c', 'm', [{ note: 'merge them', when: 'all', agents: 'all' }])
  await until(() => h.ready.length > 0 && h.agents.forChat('c').every((a) => a.status === 'done'))
  await sleep(20)
  check('one hand-back for both', h.ready.length, 1)
  check('with both reports and the note', /AGENT 1: A[\s\S]*AGENT 2: B[\s\S]*merge them/.test(h.ready[0].text), true)
  check('a monitor with nothing to watch says so at once', (() => {
    h.agents.monitor('c', 'm2', [{ note: 'x', when: 'all', agents: 'all' }])
    return /no background agents working/.test(h.ready[h.ready.length - 1].text)
  })(), true)
}

{
  /* A monitor naming agents that already reported does not send them again. */
  const h = harness((messages) => (messages[0].content.startsWith('You are a reviewing agent') ? 'VERDICT: ACCEPT\nNOTES: ok' : 'REPORT:\nDone.'))
  h.agents.start('c', 'm', [{ title: 'A', brief: 'first job here' }])
  await until(() => h.ready.length > 0)
  h.agents.monitor('c', 'm2', [{ note: 'tell them', when: 'all', agents: [1] }])
  check('a monitor on an agent that already reported does not resend it', [h.ready.length, /had already finished/.test(h.ready[1]?.text ?? '')], [2, true])
}

{
  /* No slots left: those in line are told, not kept for ever. */
  let slots = 1
  let release
  const gate = new Promise((r) => (release = r))
  const h = harness(() => 'REPORT:\nDone.')
  h.agents['deps'].slots = () => slots
  const turn = h.agents['deps'].turn
  h.agents['deps'].turn = async (...args) => (await gate, turn(...args))
  h.agents.start('c', 'm', [
    { title: 'One', brief: 'The first job.' },
    { title: 'Two', brief: 'The second job.' }
  ])
  slots = 0
  release()
  await until(() => h.agents.forChat('c')[1].status !== 'queued')
  check('with no slots left, a queued agent fails and says why', /no keys to spare/.test(h.agents.forChat('c')[1].doing), true)
}

{
  /* Stopped: no report, its key back, its monitor still told. */
  const h = harness(() => null)
  const [a] = h.agents.start('c', 'm', [{ title: 'Slow', brief: 'Takes forever.' }])
  h.agents.stop(a.id)
  check('a stopped agent gives its key back and reports nothing', [h.agents.forChat('c')[0].status, h.held.size, h.ready.length], ['stopped', 0, 0])
}

{
  /* Refused commands come back as NOT RUN, and the agent carries on. */
  const h = harness((messages) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: ok'
    const last = messages[messages.length - 1].content
    return last.startsWith('NOT RUN') ? 'REPORT:\nCould not check: it needs a click. Run df -h.' : `${BT}wumpy-run-bash\n# x\nrm -rf /tmp/x\n${BT}`
  }, { refuse: true })
  h.agents.start('c', 'm', [{ title: 'Clean', brief: 'Clean the temp folder.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('a refused command is a step, not a failure', [v.status, v.steps[0]?.ok], ['done', false])
}

{
  /* A report with a page that breaks goes back before any review. */
  const h = harness((messages) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: ok'
    const last = messages[messages.length - 1].content
    return last.includes('Wumpy loaded the page in your report')
      ? 'REPORT:\n<!doctype html><html><body><script>ok()</script></body></html>'
      : 'REPORT:\n<!doctype html><html><body><script>car.x()</script></body></html>'
  })
  let loads = 0
  h.agents['deps'].checkPage = async (html) => (loads++, html.includes('car.x') ? { ran: true, ok: false, output: 'Its console showed:\n- Uncaught ReferenceError: car is not defined' } : { ran: true, ok: true, output: 'no errors' })
  h.agents.start('c', 'm', [{ title: 'Game', brief: 'Build a game page.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('a page that breaks goes back to its agent before review', [loads, v.report.includes('ok()'), v.steps.map((s) => s.ok)], [2, true, [false, true]])
}

{
  /* A reply cut off by the length limit is carried on and joined. */
  let calls = 0
  const h = harness(() => null)
  h.agents['deps'].turn = async (_m, messages) => {
    calls++
    if (messages[0].content.startsWith('You are a reviewing agent')) return { text: 'VERDICT: ACCEPT\nNOTES: ok', status: 200, promptTokens: 1, completionTokens: 1, ms: 1 }
    const last = messages[messages.length - 1].content
    if (last.startsWith('Your reply was cut off')) return { text: 'arc(1)</script></html>', status: 200, promptTokens: 1, completionTokens: 1, ms: 1 }
    return { text: 'REPORT:\n<!doctype html><html><script>ctx.', cutOff: true, status: 200, promptTokens: 1, completionTokens: 1, ms: 1 }
  }
  h.agents['deps'].checkPage = async () => ({ ran: true, ok: true, output: 'no errors' })
  h.agents.start('c', 'm', [{ title: 'Long', brief: 'A long page.' }])
  await until(() => h.ready.length > 0)
  check('a reply cut off at the length limit is carried on, joined exactly', h.agents.forChat('c')[0].report, '<!doctype html><html><script>ctx.arc(1)</script></html>')
}

{
  /* A revision that breaks a page that worked: the working one stands. */
  const h = harness((messages) => {
    if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: REVISE\nNOTES:\n1. Make the canvas taller.'
    const asked = messages.filter((m) => m.role === 'user').length
    return asked === 1
      ? 'REPORT:\n<!doctype html><html><body><script>good()</script></body></html>'
      : 'REPORT:\n<!doctype html><html><body><script>broken()</script></body></html>'
  })
  h.agents['deps'].checkPage = async (html) => (html.includes('broken') ? { ran: true, ok: false, output: 'did not move the player at all' } : { ran: true, ok: true, output: 'moved' })
  h.agents.start('c', 'm', [{ title: 'Game', brief: 'Build a game page.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('a revision that breaks a working page is dropped for the one that worked', [v.report.includes('good()'), /the one before it stands/.test(v.review)], [true, true])
}

/* --------------------------------------------------------- key limits */

const t0 = 1_000_000
const samples = (n, gap, refusedAt) =>
  Array.from({ length: n }, (_, i) => ({ at: t0 + i * gap, status: refusedAt !== undefined && i >= refusedAt ? 429 : 200 }))
check('refused at the 41st: its limit is 40', L.limitFrom(samples(45, 1200, 40), 3, t0), { rpm: 40, capped: true, at: t0, keys: 3 })
check('never refused: at least what it took in a minute', L.limitFrom(samples(62, 1200), 3, t0), { rpm: 50, capped: false, at: t0, keys: 3 })
check('a handful of answers is not a reading', L.limitFrom(samples(3, 1200), 3, t0), null)
check('server errors are not counted as refusals', L.limitFrom([...samples(10, 1200), { at: t0 + 13_000, status: 500 }], 3, t0)?.capped, false)
check('the key tested longest ago goes next', L.dueKey({ 'nvidia:0': { rpm: 40, capped: true, at: t0, keys: 3 } }, 'nvidia', 3, t0 + 1000), 1)
check('none due inside a day', L.dueKey({ 'nvidia:0': { rpm: 40, capped: true, at: t0, keys: 2 }, 'nvidia:1': { rpm: 40, capped: true, at: t0, keys: 2 } }, 'nvidia', 2, t0 + 3_600_000), null)
check('a different set of keys is tested again', L.dueKey({ 'nvidia:0': { rpm: 40, capped: true, at: t0, keys: 2 } }, 'nvidia', 3, t0 + 1000), 0)
check('40 a minute is paced at a tenth under', L.gapFor({ rpm: 40, capped: true, at: t0, keys: 3 }, 3), 1667)
check('never faster than a second', L.gapFor({ rpm: 200, capped: false, at: t0, keys: 3 }, 3), 1000)
check('a stale reading is not used', L.gapFor({ rpm: 40, capped: true, at: t0, keys: 2 }, 3), null)
check('said for the log', L.limitLine(1, { rpm: 40, capped: true, at: t0, keys: 3 }), 'key 2 takes 40 requests a minute')

/* ------------------------------------------------------ pages, checked */

const PC = await load('src/shared/pagecheck.ts', 'pagecheck')
const mainSource = read('src/main/index.ts')
const chromiumLog = [
  '[73847:73847:1119/085343.327668:INFO:CONSOLE:1] "started", source: file:///tmp/x/bad.html (1)',
  '[73847:73847:1119/085343.354723:INFO:CONSOLE:142] "Uncaught ReferenceError: car is not defined", source: file:///tmp/x/bad.html (142)',
  '[73847:73847:1119/085343.354723:INFO:CONSOLE:142] "Uncaught ReferenceError: car is not defined", source: file:///tmp/x/bad.html (142)'
].join('\n')
check('a crash in the console is found, once, with its line', PC.pageErrors(chromiumLog), ['Uncaught ReferenceError: car is not defined (line 142)'])
check('an ordinary console.log is not an error', PC.pageErrors(chromiumLog.split('\n')[0]), [])
check('the hand-back says it was the app, and to read the file', /sent by Wumpy, not typed by the user/.test(PC.pageErrorText('/x.html', ['e'])) && /never a picture tool/.test(PC.pageErrorText('/x.html', ['e'])), true)
check('and quotes the lines the errors point at', PC.excerpts('a\nb\nc\nboom()\ne', ['Uncaught ReferenceError: boom is not defined (line 4)']).includes('>4 | boom()'), true)
const seen = (player) => ({ player })
check('the play test sees a player that moved', PC.playFrom(seen({ x: 5, y: 10 }), seen({ x: 5, y: 7 })).moved, true)
check('and one that only set its target, which did not', PC.playFrom(seen({ col: 5, row: 11, targetRow: 11, t: 1 }), seen({ col: 5, row: 11, targetRow: 10, t: 0 })).moved, false)
check('and says nothing for a page with no player', PC.playFrom({}, {}).moved, null)
check('a flat playerX / playerY counts as where the player is', PC.playFrom(seen({ playerX: 5, playerY: 14 }), seen({ playerX: 5, playerY: 11 })).moved, true)
check('it looks for the player by the names games use', /'player', 'chicken', 'frog', 'hero'/.test(PC.LOOK_JS), true)
check('pages are checked in a hidden window with no network', /offscreen: true/.test(read('src/main/pagecheck.ts')) && /done\(\{ cancel: !local \}\)/.test(read('src/main/pagecheck.ts')), true)
check('a stuck player goes back to the chat as an error', /page\.play\?\.moved === false \? \[page\.play\.line\]/.test(mainSource), true)
check('an agent may refuse a wrong review note, saying why', /A note can be wrong/.test(read('src/main/agents.ts')), true)
check('a page written is loaded and its errors handed back, twice at most', /checkPage\(result\.path\)/.test(mainSource) && /rounds >= PAGE_ROUNDS/.test(read('src/renderer/src/App.tsx')), true)
check('the write rules say code that runs is not done when written', /CODE THAT RUNS IS NOT DONE WHEN IT IS\s+WRITTEN/.test(read('src/shared/writefile.ts').replace(/',\s*'/g, ' ')) && /GAME, PAGE, APP OR WHOLE PROGRAM is a background agent/.test(read('src/shared/writefile.ts')) && /READ\s+THE FILE before you answer/.test(read('src/shared/writefile.ts').replace(/',\s*'/g, ' ')), true)
check('and so does the /reflect mentor', /cross the screen in a twentieth of a second is not done/.test(read('src/shared/reflect.ts').replace(/',\s*'/g, ' ')), true)

/* ---------------------------------------- programs, compiled not run */

const CC = await load('src/shared/codecheck.ts', 'codecheck')
check('the program in a report is its longest checkable block', CC.codeIn('REPORT:\n```python\n' + 'x = 1\n'.repeat(8) + '```\nRun it:\n```bash\npython3 t.py\n```')?.lang, 'python')
check('a one-line run command is not a program', CC.codeIn('```bash\npython3 t.py\n```'), null)
check('an include outside the program is never compiled', ['#include "/etc/passwd"', '#include "../../.ssh/id_rsa"', '#include MACRO', '#embed "x.bin"', '#include <C:/keys.txt>', '#pragma GCC dependency "x"'].every((l) => CC.unsafeInclude(l) !== null), true)
check('ordinary includes are', CC.unsafeInclude('#include <iostream>\n#include "game.h"\n#include <ncurses.h>'), null)
check('a curses game links ncurses', CC.librariesFor('#include <ncurses.h>\nint main(){}', 'linux'), ['-lncursesw'])
check('Python is read, never run: parsed, its names and its imports looked up', /ast\.parse/.test(CC.PY_CHECK) && /symtable/.test(CC.PY_CHECK) && /find_spec/.test(CC.PY_CHECK) && !/runpy|exec\(src|import_module/.test(CC.PY_CHECK), true)
check('a file is its language by its extension', ['a.py', 'b.cpp', 'c.c', 'd.mjs', 'e.sh', 'f.html'].map(CC.langOfPath), ['python', 'cpp', 'c', 'javascript', 'bash', null])
check('code in a report is checked before review, like a page', /const program = page \? null : codeIn\(step\.text\)/.test(read('src/main/agents.ts')), true)
check('and a missing module is said once, not sent back for ever', /!missingSaid/.test(read('src/main/agents.ts')), true)
check('a program the chat writes is checked, its errors handed back', /checkCodeFile\(result\.path\)/.test(mainSource) && /codeErrorText\(result\.path, code\.lang/.test(read('src/renderer/src/App.tsx')), true)
check('the play test loses, restarts, and sees whether the game runs again', /did not start again/.test(read('src/main/pagecheck.ts')) && /run\(HOOK_JS\)/.test(read('src/main/pagecheck.ts')), true)
check('it finds a snake by its head, and a game over on the canvas', /head\(get\('snake'\)\)/.test(PC.LOOK_JS) && /fillText/.test(PC.HOOK_JS), true)
const at = (name, pts) => ({ crowd: { [name]: pts } })
check('ghosts bobbing in their pen are found', PC.stuckCrowds([at('ghosts', [[324, 302], [324, 323]]), at('ghosts', [[324, 323], [322, 325]]), at('ghosts', [[325, 310], [323, 324]])]), ['ghosts'])
check('and cars that drive are not', PC.stuckCrowds([at('cars', [[10, 1], [200, 2]]), at('cars', [[90, 1], [120, 2]])]), [])
check('nor invaders that went and came back', PC.stuckCrowds([at('aliens', [[100, 50]]), at('aliens', [[160, 50]]), at('aliens', [[102, 60]])]), [])
check('a tile game moving two tiles is moving', PC.stuckCrowds([at('ghosts', [[9, 11]]), at('ghosts', [[11, 11]])]), [])
const fastLook = (t, pts) => ({ t, crowd: { cars: pts } })
check('cars at a dozen times their speed are too fast', PC.tooFast(fastLook(0, [[1, 3], [5, 4]]), fastLook(200, [[4, 3], [2, 4]])).map((f) => f.name), ['cars'])
check('cars at two tiles a second are not', PC.tooFast(fastLook(0, [[1, 3], [5, 4]]), fastLook(200, [[1.4, 3], [4.6, 4]])), [])
check('nor one wrapping round the screen', PC.tooFast(fastLook(0, [[9.9, 3], [5, 4]]), fastLook(200, [[-1, 3], [5.3, 4]])), [])
/* Standing in the road: a car through the player and nothing happening. */
const road = (t, carX, extra = {}) => ({ t, player: { col: 5, row: 11 }, harm: [[carX, 11, 1], [2, 9, 1]], over: false, ...extra })
const drive = (xs, after = {}) => xs.map((x, i) => road(i * 100, x, i === xs.length - 1 ? after : {}))
check('a car through a player who stays is missed', PC.standInTraffic(drive([3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5])).verdict, 'missed')
check('one that ends the game is a hit', PC.standInTraffic(drive([3, 3.5, 4, 4.5, 5], { over: true })).verdict, 'hit')
check('and a life lost is a hit', PC.standInTraffic(drive([3, 3.5, 4, 4.5], { lives: 2 }).map((l, i) => ({ ...l, lives: i === 3 ? 2 : 3 }))).verdict, 'hit')
check('a car in the next lane is not one in the player\'s', PC.inLane({ player: { col: 5, row: 12 }, harm: [[3, 11, 1], [4, 15, 1]] }).length, 0)
check('nor is a car wrapping round the edge a crossing', PC.standInTraffic([road(0, 11.8), road(100, -3.4), road(200, -3), road(900, -2.5)]).verdict, null)
check('a hop measures pixels per tile', PC.tileScale({ player: { row: 14, y: 524 } }, { player: { row: 13, y: 484 } }), 40)
check('a drift of a twentieth of a tile is not a move', PC.playFrom({ player: { row: 14, col: 3.44 } }, { player: { row: 14, col: 3.4 } }).moved, false)
check('a hop of a tile is', PC.playFrom({ player: { row: 14, col: 3 } }, { player: { row: 13, col: 3 } }).moved, true)
{
  /* Standing the player in a lane moves where it is, never how fast. */
  const js = PC.teleportJs({ player: { col: 5, row: 12, targetRow: 12, velY: -2, dirY: 1, startY: 12, spawnRow: 12 }, harm: [[3, 11, 1], [4, 9, 1]], over: false })
  check('the stand moves row and targetRow', /"row":-1/.test(js ?? '') && /"targetRow":-1/.test(js ?? ''), true)
  check('but not velY, dirY, startY or spawnRow', /velY|dirY|startY|spawnRow/.test(js ?? ''), false)
  const round = PC.teleportJs({ player: { x: 200, y: 400, r: 6 }, harm: [[150, 360, 40], [90, 320, 40]], over: false })
  check('a radius r is not moved as a row', /"r":/.test(round ?? ''), false)
  check('an r beside a c is a row', /"r":-1/.test(PC.teleportJs({ player: { c: 5, r: 12 }, harm: [[3, 11, 1], [4, 9, 1]], over: false }) ?? ''), true)
}
check('a car kept in two lists is one car', /const added = new Set\(\)/.test(read('src/shared/pagecheck.ts')) && /added\.has\(o\)/.test(read('src/shared/pagecheck.ts')), true)
check('cars stacked on one another in a lane are said', PC.bunched({ t: 0, harm: [[3, 1, 1], [3, 1, 1], [7, 3, 1]] }, { t: 1500, harm: [[5, 1, 1], [5, 1, 1], [8, 3, 1]] }) !== '', true)
check('cars spread along a lane are not', PC.bunched({ t: 0, harm: [[1, 1, 1], [5, 1, 1], [9, 1, 1]] }, { t: 1500, harm: [[2, 1, 1], [6, 1, 1], [10, 1, 1]] }), '')
check('builds get a third review, since the reviewer sees them', /isBuild\(agent\.brief\) \? BUILD_REVIEW_ROUNDS : REVIEW_ROUNDS/.test(read('src/main/agents.ts')), true)
check('a reviewer that can see is shown the page, and its game-over screen', /this\.deps\.sees\(agent\.model\)/.test(read('src/main/agents.ts')) && /shots!\.map\(\(url\) => \(\{ type: 'image_url' as const/.test(read('src/main/agents.ts')) && /overShot/.test(read('src/main/pagecheck.ts')), true)
check('a guarded import is optional, not missing', /optional\.add\(n\.lineno\)/.test(CC.PY_CHECK), true)
check('build agents build maps in code and check them as they start', /fill a grid from\s+a list of wall rectangles/.test(A.BUILDING.join(' ')) && /flood-fill from the player/.test(A.BUILDING.join(' ')), true)
check('keys are held, not tapped', /keyJs\(key, 'keydown'\)[\s\S]{0,80}await sleep\(ms\)[\s\S]{0,80}keyJs\(key, 'keyup'\)/.test(read('src/main/pagecheck.ts')), true)

const TK = await load('src/shared/faketk.ts', 'faketk')
check('a tkinter game frozen after its restart is caught', TK.tkVerdict('KEY Left bound\nOVER 90000\nRESTARTED space\nMOVING no\nEND').ok, false)
check('and one that restarts and runs is not', TK.tkVerdict('KEY Left bound\nOVER 90000\nRESTARTED Return\nMOVING yes\nEND'), { ok: true, line: 'Played until it was over, and Enter started a new game that runs.' })
check('nor one whose loop stops by itself', TK.tkVerdict('KEY Left bound\nSTOPPED 4000\nEND').ok, false)
check('nor one that freezes while its loop runs on', TK.tkVerdict('KEY Left bound\nSTILL 6000\nEND').ok, false)
check('the stand-in runs the game on its own clock, never a real window', /def _run\(\)/.test(TK.FAKE_TK) && !/import _tkinter/.test(TK.FAKE_TK), true)
check('a C or C++ game is played with the memory checks on', /-fsanitize=address,undefined/.test(read('src/main/codecheck.ts')) && /'ASAN_OPTIONS', 'detect_leaks=0'/.test(read('src/main/codecheck.ts')), true)
check('tkinter games are played through it in the sandbox', /PYTHONPATH: '\/work\/faketk'/.test(read('src/main/codecheck.ts')), true)

/* ------------------------------------------- files saved, not retyped */

const pageReport = 'REPORT:\n```html\n<!DOCTYPE html>\n<html><body><canvas></canvas><script>let a = 1</script></body></html>\n```\nChecked: loaded.'

const W = await load('src/shared/writefile.ts', 'writefile')
const asWritten = W.readWriteRequest('# Save the game\npath: ~/Downloads/snake.html\nfrom: agent-7\n')
check('a write block can name an agent\'s file instead of holding it', [asWritten.path, asWritten.from, asWritten.content], ['~/Downloads/snake.html', 'agent-7', ''])
check('and an ordinary one is as it was', W.readWriteRequest('path: a.py\n---\nprint(1)\n').from, null)
check('a from: line wins over anything typed after it', [W.readWriteRequest('path: a.html\nfrom: agent-1\n---\n<html>invented</html>\n').content, W.readWriteRequest('path: a.html\nfrom: agent-1\n---\n<html>invented</html>\n').from], ['', 'agent-1'])
const handedBroken = A.deliveryText([{ id: 'agent-7', broken: true, file: { lines: 2, kind: 'a web page' }, number: 1, title: 'Pac-Man', ok: true, text: pageReport, tookMs: 60000, review: 'it still breaks', steps: 2, ran: [] }], null)
check('a build that never passed is not offered for saving', !/from: agent-7\n/.test(handedBroken) && /IT DOES NOT WORK YET/.test(handedBroken) && /start one more agent/.test(handedBroken), true)
check('a build that never passed goes back saying so', /WUMPY'S TEST OF THIS FINAL VERSION FOUND IT STILL BROKEN/.test(read('src/main/agents.ts')), true)
check('the file in a report is its page, exactly', A.fileIn(pageReport)?.text, '<!DOCTYPE html>\n<html><body><canvas></canvas><script>let a = 1</script></body></html>\n')
check('or its longest block', A.fileIn('REPORT:\n```cpp\n' + 'int x;\n'.repeat(7) + '```\nRun:\n```bash\ng++ a.cpp\n```')?.kind, 'cpp code')
const handed = A.deliveryText([{ id: 'agent-7', file: { lines: 180, kind: 'a web page' }, number: 1, title: 'Snake', ok: true, text: 'the page', tookMs: 60000, review: 'accepted', steps: 2, ran: [] }], null)
check('the hand-back says to save it by reference, never retyped, with the block to write', /from: agent-7/.test(handed) && /Never retype the file/.test(handed) && /```wumpy-write\n# Save Snake\npath: <the path they asked for>\nfrom: agent-7\n```/.test(handed), true)
check('an agent trying to save its file is told it never does', /you never save files/.test(read('src/main/agents.ts')), true)
const handedPage = A.deliveryText([{ id: 'agent-7', file: { lines: 2, kind: 'a web page' }, number: 1, title: 'Snake', ok: true, text: pageReport, tookMs: 60000, review: 'accepted', steps: 2, ran: [] }], null)
check('and does not show the file, so it cannot be retyped', !/<canvas>/.test(handedPage) && /not shown here; it is saved as written with from: agent-7/.test(handedPage) && /Checked: loaded/.test(handedPage), true)
check('the write card fetches an agent\'s file itself', /window\.wumpy\.agents\s*\.file\(from\)/.test(read('src/renderer/src/components/WriteCard.tsx')), true)
check('a terminal game is played in a sandbox, without the home folder or network', /'--unshare-all'/.test(read('src/main/codecheck.ts')) && !/--bind', homedir|ro-bind', '\/home/.test(read('src/main/codecheck.ts')), true)

/* ------------------------------------------------ fixed by edits */

const editReply = 'Fixing the maze.\n```wumpy-edit\nFIND:\n  if (maze[y][x] === 0) dotCount++;\nREPLACE:\n  if (maze[y] && maze[y][x] === 0) dotCount++;\nFIND:\nconst ROWS = 30;\nREPLACE:\nconst ROWS = maze.length;\n```'
check('edits are read from a reply, pair by pair', A.editsIn(editReply).map((e) => e.find.trim()), ['if (maze[y][x] === 0) dotCount++;', 'const ROWS = 30;'])
check('and a reply with them is an edit step', A.stepOf(editReply, 'linux').kind, 'edit')
const gameFile = 'const ROWS = 30;\nfunction count() {\n    if (maze[y][x] === 0) dotCount++;\n}\n'
const madeEdits = A.applyEdits(gameFile, A.editsIn(editReply))
check('they are made to the file, its own indentation kept', madeEdits.ok && madeEdits.text, 'const ROWS = maze.length;\nfunction count() {\n    if (maze[y] && maze[y][x] === 0) dotCount++;\n}\n')
check('even when the indentation was copied wrong', A.applyEdits('a\n      b();\nc', [{ find: 'b();', replace: 'b2();' }]).ok, true)
check('a FIND that is not there changes nothing and says so', (() => { const r = A.applyEdits(gameFile, [{ find: 'const ROWS = 30;', replace: 'x' }, { find: 'nowhere()', replace: 'y' }]); return !r.ok && /not in your file/.test(r.why) })(), true)
check('nor one that is in two places', (() => { const r = A.applyEdits('a\na\n', [{ find: 'a', replace: 'b' }]); return !r.ok && /2 times/.test(r.why) })(), true)
check('the edited file takes the old one\'s place in the report', A.withFile(pageReport, '<!DOCTYPE html>\n<html><body>new</body></html>\n'), 'REPORT:\n```html\n<!DOCTYPE html>\n<html><body>new</body></html>\n```\nChecked: loaded.')
check('a continuation that repeats the cut line is joined without it', A.joinContinuation('```html\n<script>\nconst speed = 4;\nfunction mov', 'function move(dx) {\n}\n'), '```html\n<script>\nconst speed = 4;\nfunction move(dx) {\n}\n')
check('and one that reopens the fence it was cut inside', A.joinContinuation('```html\n<script>\nlet a = 1;\n', '```html\nlet b = 2;\n'), '```html\n<script>\nlet a = 1;\nlet b = 2;\n')
check('a clean continuation is left alone', A.joinContinuation('let a = 1;\nlet b', ' = 2;\n'), 'let a = 1;\nlet b = 2;\n')
check('builds get room for a whole game in one reply', /const BUILD_TOKENS = 16384/.test(read('src/main/agents.ts')) && /joinContinuation\(text, r\.text\)/.test(read('src/main/agents.ts')), true)
const retyped = 'Saving it.\n```wumpy-write\n# Save\npath: ~/a.html\nfrom: agent-1\n```\n```html\n' + '<p>x</p>\n'.repeat(14) + '```\nDone.'
check('code retyped beside a from: save is left out of the reply', /code left out/.test(A.withoutRetypedCode(retyped)) && !/<p>x<\/p>/.test(A.withoutRetypedCode(retyped)) && /from: agent-1/.test(A.withoutRetypedCode(retyped)), true)
check('and code in an ordinary reply is not', A.withoutRetypedCode('```html\n' + '<p>x</p>\n'.repeat(14) + '```'), '```html\n' + '<p>x</p>\n'.repeat(14) + '```')
check('an edit in the style models know is read too', A.editsIn('```wumpy-edit\n<<<<<<< SEARCH\nlet a = 1;\n=======\nlet a = 2;\n>>>>>>> REPLACE\n```'), [{ find: 'let a = 1;', replace: 'let a = 2;' }])
check('and FIND> for FIND:', A.editsIn('```wumpy-edit\nFIND>\nlet a = 1;\nREPLACE>\nlet a = 2;\n```'), [{ find: 'let a = 1;', replace: 'let a = 2;' }])
check('an edit whose code sits in fences of its own is still read', A.editsIn('```wumpy-edit\nFIND:\n```cpp\nint a = 1;\n```\nREPLACE:\n```cpp\nint a = 2;\n```\n```'), [{ find: 'int a = 1;', replace: 'int a = 2;' }])
check('and what is left of a broken one is never the file', A.fileIn('```wumpy-edit\nFIND:\nint a;\n```\nREPLACE:\nint b;\nint c;\nint d;\nint e;\nint f;\nint g;\n```\nmore'), null)
check('a tool block is never the file in a report', A.fileIn('REPORT:\n```wumpy-edit\nFIND>\na\nb\nc\nd\ne\nf\n```'), null)
check('a build report without its file is sent back, not saved', /Your report has no file in it/.test(read('src/main/agents.ts')), true)
check('nor one with only part of it', /Your report has only part of the file/.test(read('src/main/agents.ts')) && /now\.text\.length < before\.text\.length \* 0\.4/.test(read('src/main/agents.ts')), true)
check('a game written beside the agent building it is held', A.heldForAgent('I have an agent on it.\n```wumpy-agent\n# Build\nbrief\n```\n```wumpy-write\npath: ~/a.html\n---\n<html></html>\n```', { path: '~/a.html' }), true)
check('but not a save of the agent\'s own file, nor a note', [A.heldForAgent('```wumpy-agent\n# B\nb\n```', { path: '~/a.html', from: 'agent-1' }), A.heldForAgent('```wumpy-agent\n# B\nb\n```', { path: '~/notes.txt' })], [false, false])
check('agents are told they can fix by edits, on a file Wumpy keeps', /Wumpy keeps it; it is on no disk/.test(linux) && /wumpy-edit blocks:/.test(linux), true)
check('and can see it as it is now', A.stepOf('```wumpy-show\n```', 'linux').kind === 'show' && /wumpy-show block/.test(linux), true)
check('and look inside its page before changing it', A.stepOf('```wumpy-probe\npress: Space\nshow: pacman\n```', 'linux'), { kind: 'probe', script: 'press: Space\nshow: pacman\n' })
check('build agents are told to look before they change code', /wumpy-probe block plays your page and reads values back/.test(A.BUILDING.join(' ')), true)
check('a missed FIND is shown the closest place as it reads now', (() => { const r = A.applyEdits('a\nlet speed = 4;\nb', [{ find: 'let speed = 5', replace: 'x' }]); return !r.ok && /let speed = 4;/.test(r.why) })(), true)
check('a runaway reply is not carried on for ever', /text\.length > 45_000/.test(read('src/main/agents.ts')), true)
check('nor a reply of many tool blocks taken as a step', /that reply held \$\{blocks\} tool blocks/.test(read('src/main/agents.ts')), true)
check('and only the newest version of a file stays in what an agent reads', /an earlier version of the file/.test(read('src/main/agents.ts')) && /leaner\(messages\)/.test(read('src/main/agents.ts')), true)
check('a build asked for is said beside the message', /\.\.\.buildFacts\(messages\)/.test(mainSource), true)

/* -------------------------------------------- hearing, copying, cards */

check('a slow Whisper is raced by Parakeet on a fresh connection', /recognize\(audio, borrowed, FALLBACK_HEARING, true\)/.test(mainSource) && /startParakeet\('Whisper was slow'\)/.test(mainSource), true)
check('dictation writes what it did to the log', /note\(held \? 'Space held: starting' : 'started'\)/.test(read('src/renderer/src/hooks/useDictation.ts')), true)
check('what they wrote can be copied, from their own message', /msg-copy msg-copy-user/.test(read('src/renderer/src/components/Message.tsx')), true)
check('a finished command keeps "done" when its card is rebuilt', /rememberOutcome\(ranKey, res\)/.test(read('src/renderer/src/components/CommandCard.tsx')) && /outcomeOf<ShellResult \| 'cancelled'>\(`run:\$\{messageId\}:\$\{command\}`\)/.test(read('src/renderer/src/components/CommandCard.tsx')), true)

/* ------------------------------------------------------------ wiring */

const main = read('src/main/index.ts')
check('agents run only reads judge() would run without a click', /const verdict = judge\(command\)[\s\S]{0,1000}if \(!verdict\.auto \|\| !verdict\.readOnly\)/.test(main), true)
check('and with one key there are none', /Background agents need at least two keys/.test(main), true)
check('the ranker stands aside while agents work, and while a key is tested', (main.match(/busy: turnStartedAt !== null \|\| \(agents\?\.active\(\) \?\? 0\) > 0 \|\| \(limitTester\?\.busy \?\? false\),/g) ?? []).length, 2)
check('agents never read secrets, in any mode', [
  'cat ~/.ssh/id_rsa',
  'cat ~/.config/wumpy/keys.bin',
  'cat .env',
  'type C:\\Users\\me\\.aws\\credentials'
].every((c) => new RegExp(/const AGENT_SECRETS =\s*\n\s*(\/.*\/i)/.exec(main)[1].slice(1, -2), 'i').test(c)), true)
check('a key limit is only measured on NVIDIA', /provider: \(\) => \(providerFor\(activeModel\(\)\) === 'nvidia' \? 'nvidia' : null\)/.test(main), true)
check('the chat is told about its agents', /\.\.\.agentFacts\(chatId\)/.test(main), true)
check('a limit test stops when Wumpy is used', /if \(!this\.idle\(\)\) \{\s+controller\.abort\(\)/.test(read('src/main/limits.ts')), true)
check('agents are started when an answer finishes, not when a card draws', /window\.wumpy\.agents\s+\.start\(d\.chatId, message\.id, message\.content\)/.test(read('src/renderer/src/hooks/useAgents.ts')), true)

{
  /* Out of steps and still probing its page: it ends. Observed live: an
     agent probed its Crossy Road the same way 28 times in seven minutes. */
  let probes = 0
  const h = harness(
    (messages, turn) => {
      if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: Fine.'
      if (turn === 1) return `REPORT:\nThe game.\n${BT}html\n<!doctype html><html><body><canvas></canvas><script>let x = 1</script></body></html>\n${BT}`
      probes++
      return `${BT}wumpy-probe\npress: ArrowUp\nwait: ${probes}\nshow: x\n${BT}`
    },
    {
      deps: {
        checkPage: async () => ({ ran: true, ok: false, output: 'Holding each arrow key did not move the player at all.' }),
        probePage: async () => ({ ran: true, ok: true, output: 'x = 1' }),
        sees: () => false
      }
    }
  )
  h.agents.start('c', 'm', [{ title: 'Build a game', brief: 'Build a Snake game in one HTML file.' }])
  await until(() => h.ready.length > 0 || h.turns() > 40)
  const v = h.agents.forChat('c')[0]
  check('an agent out of steps that keeps probing is ended', [h.ready.length, probes <= 11], [1, true])
  check('and a page that never passed goes back as broken, not as done', [v.review, /STILL BROKEN/.test(h.ready[0]?.text ?? '')], ['it still breaks when Wumpy tests it', true])
}
{
  /* The same probe twice is answered from the first time. */
  const h = harness(
    (messages, turn) => {
      if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: Fine.'
      if (turn === 1) return `REPORT:\nThe game.\n${BT}html\n<!doctype html><html><body><script>let x = 1</script></body></html>\n${BT}`
      return `${BT}wumpy-probe\npress: ArrowUp\nshow: x\n${BT}`
    },
    {
      deps: {
        checkPage: async () => ({ ran: true, ok: false, output: 'did not move' }),
        probePage: async () => ({ ran: true, ok: true, output: 'x = 1' }),
        sees: () => false
      }
    }
  )
  h.agents.start('c', 'm', [{ title: 'Build a game', brief: 'Build a Snake game in one HTML file.' }])
  await until(() => h.ready.length > 0 || h.turns() > 40)
  check('a repeated probe is not run again, and the agent ends', [h.ready.length, h.log.filter((l) => /probed its page/.test(l)).length], [1, 1])
}
{
  /* Asked to change a saved game: it reads it, edits what it read. */
  const GAME = '<!doctype html><html><body><canvas></canvas><script>let hit = false</script></body></html>'
  const h = harness(
    (messages, turn) => {
      if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: Fine.'
      if (turn === 1) return `${BT}wumpy-run-bash\n# The game as saved\ncat ~/Downloads/crossy-road.html\n${BT}`
      if (turn === 2) return `${BT}wumpy-edit\nFIND:\nlet hit = false\nREPLACE:\nlet hit = true\n${BT}`
      return 'REPORT:\nDone.'
    },
    {
      deps: {
        run: async () => ({ ran: true, ok: true, output: `Exit code 0, 0.0s.\nOutput:\n${GAME}` }),
        checkPage: async () => ({ ran: true, ok: true, output: 'Loaded it and played it: no errors.' }),
        sees: () => false
      }
    }
  )
  h.agents.start('c', 'm', [{ title: 'Make cars kill', brief: 'Change the Crossy Road game at ~/Downloads/crossy-road.html so a car kills the player. Hand back the whole file.' }])
  await until(() => h.ready.length > 0)
  const v = h.agents.forChat('c')[0]
  check('edits change the file it read, when it wrote none', [v.status, /let hit = true/.test(v.report ?? ''), /<!doctype html>/.test(v.report ?? '')], ['done', true, true])
}
check('an edit whose FIND drops a blank line or a double space still lands', A.applyEdits('a();\n\nlet  x = 1;\nb();\n', [{ find: 'a();\nlet x = 1;', replace: 'a();\nlet x = 2;' }]), { ok: true, text: 'a();\nlet x = 2;\nb();\n' })
check('a change to how a built game plays is a change, with no game named', N.asksToBuild('make it so I die when I get hit by the cars, and also space out the cars a little', true), 'change')
check('and "the ghosts are too fast, slow them down"', N.asksToBuild('the ghosts should be slower, can you slow them down', true), 'change')
check('but not before anything was built', N.asksToBuild('make it so I die when I get hit by the cars', false), null)
check('nor an ordinary question after a build', ['I want to restart my computer', 'can you show my ssh keys', 'let me know the score of the match', 'change my desktop background'].map((t) => N.asksToBuild(t, true)), [null, null, null, null])
check('only a build agent counts as something built', /agentAsks\(text\(m\)\)\.some\(\(a\) => isBuild\(/.test(read('src/main/index.ts')), true)
check('nor a question after one', N.asksToBuild('what time is it in Tokyo', true), null)
check('the chat knows when something was built here', /const built = messages\.some\(\s*\(m\) => m\.role === 'assistant' && agentAsks/.test(read('src/main/index.ts')), true)
check('an earlier card whose file is there word for word says saved, with no buttons', /const already = earlier && target\?\.same === true/.test(read('src/renderer/src/components/WriteCard.tsx')) && /!missingFrom && !already/.test(read('src/renderer/src/components/WriteCard.tsx')), true)
check('chat cards keep the same component functions across renders', /const components = useMemo<Components>/.test(read('src/renderer/src/components/Markdown.tsx')) && /components=\{components\}/.test(read('src/renderer/src/components/Markdown.tsx')), true)
check('a failed build goes back saying to start one more agent, never to write it', /start one more agent with the same brief - never write the file yourself/.test(A.deliveryText([{ number: 1, title: 'Build a Crossy Road game in one HTML file', ok: false, text: 'its replies kept running far too long', tookMs: 1000, review: '', steps: 3 }], null)), true)
{
  /* One probe written over and over to the length limit: the first is used. */
  let asked = 0
  const h = harness(
    (messages, turn) => {
      if (messages[0].content.startsWith('You are a reviewing agent')) return 'VERDICT: ACCEPT\nNOTES: Fine.'
      if (turn === 1) return `REPORT:\nThe game.\n${BT}html\n<!doctype html><html><body><script>let x = 1</script></body></html>\n${BT}`
      if (turn === 2) return Array.from({ length: 40 }, () => `${BT}wumpy-probe\npress: Space\nshow: x\n${BT}`).join('\n')
      asked++
      return `REPORT:\nThe game.\n${BT}html\n<!doctype html><html><body><script>let x = 2</script></body></html>\n${BT}`
    },
    {
      deps: {
        checkPage: async (html) => (/x = 2/.test(html) ? { ran: true, ok: true, output: 'fine' } : { ran: true, ok: false, output: 'did not move' }),
        probePage: async () => ({ ran: true, ok: true, output: 'x = 1' }),
        sees: () => false
      }
    }
  )
  h.agents.start('c', 'm', [{ title: 'Build a game', brief: 'Build a Snake game in one HTML file.' }])
  await until(() => h.ready.length > 0)
  check('a reply of one probe forty times runs the first, once', [h.log.filter((l) => /probed its page/.test(l)).length, h.log.some((l) => /wrote 40 tool blocks in one reply: using the first/.test(l)), h.agents.forChat('c')[0].status], [1, true, 'done'])
}
{
  const GAME = '<!doctype html><html><body><canvas></canvas><script>' + 'let x = 0;\n'.repeat(200) + 'requestAnimationFrame(loop)</script></body></html>'
  const wrote = (path) => 'Here it is.\n```wumpy-write\npath: ' + path + '\n---\n' + GAME + '\n```'
  check('a game the chat wrote itself is taken from it', A.gameWritten(wrote('~/Downloads/crossy.html')), '~/Downloads/crossy.html')
  check('but not one written beside an agent, nor saved from one, nor a notes file', [A.gameWritten(wrote('~/a.html') + '\n```wumpy-agent\n# B\nb\n```'), A.gameWritten('```wumpy-write\npath: ~/a.html\nfrom: agent-2\n```'), A.gameWritten(wrote('~/notes.txt'))], [null, null, null])
  check('a change taken over reads the file and edits it', /read it whole with a plain `cat ~\/a.html`/.test(A.takeOverAsk('make the cars kill me', '~/a.html', true).brief), true)
}
check('the panel holds a game the chat wrote itself while an agent takes it', /gameWritten\(message\.content\)/.test(read('src/renderer/src/hooks/useAgents.ts')) && /<HeldForTakeOver/.test(read('src/renderer/src/components/Markdown.tsx')), true)
check('an edit mixing ======= and REPLACE: keeps the word out of the code', A.editsIn('```wumpy-edit\n<<<<<<< SEARCH\nlet a = 1\n=======\nREPLACE:\nlet a = 2\n>>>>>>> REPLACE\n```'), [{ find: 'let a = 1', replace: 'let a = 2' }])
check('a probe that repeats one line to the limit is kept once, and closed', A.withoutRepeats('```wumpy-probe\npress: Space\n' + 'show: a.b()\n'.repeat(3000) + 'show: a.'), '```wumpy-probe\npress: Space\nshow: a.b()\n```')
check('but three closing braces stay three', A.withoutRepeats('a {\n}\n}\n}\n'), 'a {\n}\n}\n}\n')
check('and two lines repeated, too', A.withoutRepeats('x\n' + 'press: Up\nwait: 300\n'.repeat(500)), 'x\npress: Up\nwait: 300\n')
check('an agent is named after the file its brief names', [A.fileNamed('Restyle ~/Downloads/wumpy-tests/pacman.html with neon walls.'), A.fileNamed('Make snake.cpp faster'), A.fileNamed('Build a Pac-Man game in one HTML file. Hand back the whole file.')], ['pacman.html', 'snake.cpp', undefined])
check('a retry of a broken build is the same thing, a new game is not', [A.sameWork('Build a Pac-Man game in one HTML file', 'Rebuild the Pac-Man game so the player moves'), A.sameWork('Build a Pac-Man game in one HTML file', 'Build a Snake game in one HTML file')], [true, false])
check('the card shows the file, not a number', /<span className="cmd-shell">\{name\}<\/span>/.test(read('src/renderer/src/components/AgentCard.tsx')), true)
check('a saved agent file names its card', /agents\.saved\(from, result\.path\)/.test(read('src/renderer/src/components/WriteCard.tsx')), true)

/* A reviewer's point the prompt already rules out is dropped, not obeyed. */
{
  const r = (notes) => A.withoutNonBugs({ verdict: 'revise', notes })
  check('the snake behind game over alone is an accept', r("1. The game-over overlay is drawn while the loop stops, but the snake and food remain drawn behind it - the brief's picture shows exactly this. Clear the canvas before drawing the overlay.").verdict, 'accept')
  const both = r('1. The snake and food remain drawn behind the overlay; clear the canvas.\n2. Pressing Space after game over does not restart: the loop is never started again.')
  check('with a real bug beside it, the real bug stays', [both.verdict, both.dropped, /Space/.test(both.notes), /canvas/.test(both.notes)], ['revise', 1, true, false])
  check('a real bug alone is untouched', r('1. Pressing Space after game over does not restart.').dropped, 0)
  check('so is a colour bug', r('1. Locked pieces are drawn in the wrong colour.').verdict, 'revise')
  check('prose is one review: a real bug beside the overlay is kept', A.withoutNonBugs({ verdict: 'revise', notes: 'The cars never kill the player. Also the snake stays drawn behind the game over overlay.' }).verdict, 'revise')
  check('a game running under its overlay is a real bug', A.withoutNonBugs({ verdict: 'revise', notes: '1. The game keeps running underneath the title overlay, which never hides.' }).dropped, 0)
  check('a "3." inside a point does not split it', A.withoutNonBugs({ verdict: 'revise', notes: '1. Set lives to 3. Then reset.\n2. The board stays visible behind the game over screen.' }).notes, '1. Set lives to 3. Then reset.')
  check('an accept stays an accept', A.withoutNonBugs({ verdict: 'accept', notes: 'fine' }).verdict, 'accept')
  check('and the runner uses it', /withoutNonBugs\(parsed\)/.test(read('src/main/agents.ts')), true)
}

{
  const main = read('src/main/agents.ts')
  check('an agent whose model gives nothing moves to another, once', /if \(!r\.status && !r\.completionTokens && !agent\.movedOff\)/.test(main) && /agent\.model = next/.test(main), true)
  check('both agent runners are given the quicker model', (read('src/main/index.ts').match(/fallback: \(m\) => quickerModel\(m,/g) ?? []).length, 2)
  check('and the chat is told to act, not ask', /ACT, DO NOT ASK/.test(read('src/shared/assistant.ts')) && /never "shall I search\?"/.test(read('src/shared/assistant.ts')), true)
}

/* Out of send-backs with the reviewer still unhappy: saved, never called ready. */
{
  const d = { id: 'agent-1', number: 1, title: 'Build tetris.html', ok: true, file: { lines: 390, kind: 'a web page' }, text: 'REPORT', tookMs: 180000, review: 'sent back 3 times', steps: 4, open: '1. The next-piece preview spills off the page.' }
  const text = A.deliveryText([d], null)
  check('a build with open points is not called ready', [/IS READY/.test(text), /NOT RIGHT YET/.test(text), /spills off the page/.test(text), /from: agent-1/.test(text)], [false, true, true, true])
  check('and the chat offers another agent rather than starting one', /offer one more agent/.test(text) && /do not start that agent unless they say so/.test(text), true)
  check('one with none still is', /IS READY/.test(A.deliveryText([{ ...d, open: undefined }], null)), true)
  const main = read('src/main/agents.ts')
  check('the runner reviews the last revision once more', /const last = await this\.review\(agent, step\.text, asked/.test(main) && /agent\.openPoints = last\.notes/.test(main), true)
}

/* A failure that would only repeat does not ask for another agent. */
{
  const base = { number: 2, title: 'Build snake.html', ok: false, text: 'its replies kept running on', tookMs: 4000, review: '', steps: 3 }
  check('a first failure asks for one more agent', /start one more agent/.test(A.deliveryText([base], null)), true)
  check('a second failure at the same work asks the user instead', [/start one more agent/.test(A.deliveryText([{ ...base, noRetry: 'again' }], null)), /Do NOT start another/.test(A.deliveryText([{ ...base, noRetry: 'again' }], null))], [false, true])
  check('no keys: never another agent', /do NOT start one/.test(A.deliveryText([{ ...base, text: 'there are no keys to spare', noRetry: 'stuck' }], null)), true)
  check('a broken build after a broken build asks the user', /Do NOT start another/.test(A.deliveryText([{ ...base, ok: true, broken: true, noRetry: 'again', text: 'report' }], null)), true)
  const main = read('src/main/agents.ts')
  check('the runner marks a repeat and a stuck failure', /no keys to spare\|no key came free\|no model can answer/.test(main) && /noRetry\(agent, why, this\.agents\)/.test(main), true)
}

check('a takeover finds a relative path where the write card would', /resolve\(settings\.get\('shellCwd'\) \|\| homedir\(\), req\.path/.test(read('src/main/index.ts')), true)
check('four bad edits give up the way every other end does', /if \(badEdits >= 4\) \{\s*giveUp\(\)\s*return/.test(read('src/main/agents.ts')), true)

/* A held game write always has a way out, and only the game is held. */
{
  const agents = read('src/renderer/src/hooks/useAgents.ts')
  check('a game in an answer that errored is let go', /if \(message\.error\) \{\s*if \(written\) release\(message\.id\)/.test(agents), true)
  check('a game after a command or a report is let go, not held for good', agents.includes('if (written && !game) release(message.id)'), true)
  const md = read('src/renderer/src/components/Markdown.tsx')
  check('only the game block is held, not a README beside it', md.includes('isGameBlock(text, file)') && md.includes('game !== null && game === readWriteRequest(block).path'), true)
  const big = 'x'.repeat(1600)
  check('a quoted path is the same path the card reads', A.gameWritten('```wumpy-write\npath: "~/Downloads/a.html"\n<canvas></canvas>' + big + '\n```'), '~/Downloads/a.html')
  check('a from: card waits for its file instead of saying there is none', /if \(from\) setFromFile\(\(was\) => \(was === null \? undefined : was\)\)/.test(read('src/renderer/src/components/WriteCard.tsx')), true)
}

console.log(failed ? `\n${failed} FAILED of the agent checks` : '\nall agent checks correct')
process.exit(failed ? 1 : 0)

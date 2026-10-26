/**
 * One line per thing Wumpy did, and one line only.
 *
 * Asked for: "when you run a command or whatever, it adds a notification
 * inside your chat. If you run that same command twice consecutively, or
 * more, just update the previous one so that you can't spam."
 *
 * Two rules worth pinning, because both are easy to half-break:
 *
 * The chip is the ONLY line now. A command's output still goes to the model
 * as a turn nobody typed, but that turn is no longer shown - it used to
 * appear as a bubble on the user's own side of the panel reading
 * "Ran: `dir`". If the `automatic` flag on that send is ever dropped, the
 * transcript gets both, which is worse than what was there before.
 *
 * And "consecutively" means consecutive among chips. Wumpy's own answer and
 * the hidden hand-back sit between two runs of the same command, so a rule
 * that only looked at the last message would never collapse anything; a rule
 * that skipped everything would count up across a question the user asked in
 * between. Both failures are silent, so they are checked here.
 *
 * Run with: npm run check:notify
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.notify-check.mjs')
await build({
  entryPoints: ['src/shared/notify.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const N = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
function ok(label, condition) {
  if (!condition) failures++
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`)
}

/** A ShellResult with the fields these functions read. */
const ran = (over = {}) => ({
  command: 'dir',
  shell: 'powershell',
  cwd: 'C:\\',
  stdout: 'Mode  LastWriteTime',
  stderr: '',
  exitCode: 0,
  durationMs: 40,
  timedOut: false,
  truncated: false,
  readOnly: true,
  ...over
})

/* ------------------------------------------------------- what a run says */

check('a command that worked', N.ranLine(ran()), 'Ran `dir`')
check('one that failed', N.ranLine(ran({ exitCode: 1 })), 'Ran `dir` — it failed')
check(
  'one Wumpy stopped',
  N.ranLine(ran({ exitCode: 1, timedOut: true })),
  'Ran `dir` — stopped at the time limit'
)

/**
 * The same four judgements commandFeedback makes, from the same helpers.
 *
 * A chip reading "it failed" above a report telling the model the program is
 * not installed would be the app disagreeing with itself in public, which is
 * exactly how the docker loop read to the user.
 */
check(
  'a program that is not there',
  N.ranLine(
    ran({
      command: 'fd notes.txt',
      exitCode: 1,
      stdout: '',
      stderr: "The term 'fd' is not recognized as the name of a cmdlet"
    })
  ),
  'Ran `fd notes.txt` — nothing by that name to run'
)
check(
  'a line PowerShell could not read',
  N.ranLine(ran({ exitCode: 1, stdout: '', stderr: 'ParserError: Missing expression' })),
  'Ran `dir` — it never ran'
)
check(
  'and one it was not allowed to run',
  N.ranLine(ran({ exitCode: 1, stderr: 'Access is denied' })),
  'Ran `dir` — not allowed without admin'
)

/* A chip is one line in a 440px panel, and a command can be a paragraph. */
const long = N.ranLine(
  ran({
    command:
      'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName'
  })
)
ok(`a long command is cut (${long.length} chars)`, long.length < 70 && long.includes('…'))
ok('and the newlines go with it', !N.ranLine(ran({ command: 'a\nb' })).includes('\n'))

check('a search', N.searchedLine('pacific midnight'), 'Searched the web for "pacific midnight"')

/* ------------------------------------------------- what a plan of clicks says */

const plan = (over = {}) => ({
  ran: [
    { step: 'press "Compose"', ok: true, detail: '' },
    { step: 'type "hello"', ok: true, detail: '' }
  ],
  refused: null,
  stopped: null,
  problems: [],
  after: null,
  ...over
})

check('a plan that worked', N.desktopLine(plan()), 'Did 2 steps on your screen')
check(
  'one that was stopped',
  N.desktopLine(plan({ stopped: 'You came back to your machine.' })),
  'Stopped after 2 steps on your screen'
)
check(
  'one step that did not land',
  N.desktopLine(
    plan({ ran: [{ step: 'press "Send"', ok: false, detail: 'element-vanished' }] })
  ),
  'Did 1 step on your screen, 1 of them failed'
)
check(
  'and a plan that never started',
  N.desktopLine(plan({ refused: 'browser control is off' })),
  'Left your screen alone'
)

/* ---------------------------------------------- writes, links and the screen */

/**
 * The actions that used to be notes.
 *
 * A note is an assistant-styled bubble: Wumpy's voice, but not Wumpy's
 * receipt, and it never collapsed. A link opened three times was three
 * identical bubbles - the same spam, in the one category where repeating is
 * most likely.
 */
check(
  'a file created',
  N.wroteLine({ written: true, path: 'C:\\Users\\z\\notes.txt', bytes: 120, overwrote: false }),
  'Created `C:\\Users\\z\\notes.txt` (120 bytes)'
)
check(
  'one that replaced something',
  N.wroteLine({ written: true, path: 'C:\\a.txt', bytes: 4, overwrote: true }),
  'Replaced `C:\\a.txt` (4 bytes)'
)
check(
  'and one that could not be written',
  N.wroteLine({ written: false, path: 'C:\\a.txt', bytes: 0, overwrote: false, error: 'EACCES' }),
  'Could not write `C:\\a.txt` — EACCES'
)
check(
  'a link opened',
  N.openedLine({ opened: true, url: 'https://example.com/', host: 'example.com' }),
  'Opened `example.com` in your browser'
)
check(
  'one that did not open',
  N.openedLine({ opened: false, url: '', host: '', error: 'no browser' }),
  'Could not open that — no browser'
)
/* A photograph of the user's screen is the last thing that should happen
   quietly, and its hand-back is sent without being shown. */
check('and a look at the screen', N.screenLine(), 'Looked at your screen')

/* --------------------------------------------------- the same thing, again */

const chip = (id, content, over = {}) => ({
  id,
  role: 'system',
  content,
  createdAt: 1,
  local: true,
  notification: true,
  ...over
})
const said = (id, content) => ({ id, role: 'user', content, createdAt: 1 })
const answered = (id, content) => ({ id, role: 'assistant', content, createdAt: 1 })
/** The hand-back: a user turn the app sent, which the person never typed. */
const handback = (id) => ({ id, role: 'user', content: 'Ran: `dir`', createdAt: 1, automatic: true })

check('nothing to repeat in an empty chat', N.repeatOf([], 'notification', 'Ran `dir`'), null)
check(
  'a different command appends',
  N.repeatOf([chip('c1', 'Ran `ls`')], 'notification', 'Ran `dir`'),
  null
)
check(
  'the same one counts up',
  N.repeatOf([chip('c1', 'Ran `dir`')], 'notification', 'Ran `dir`'),
  { id: 'c1', repeat: 2 }
)

/**
 * The real shape of a loop: chip, hidden hand-back, answer, chip.
 *
 * This is the case the feature exists for and the one a last-message rule
 * gets wrong - by the time the second run happens, the last message is the
 * model's own answer to the first.
 */
check(
  'across the hand-back and the answer it produced',
  N.repeatOf(
    [
      said('u1', 'is docker installed?'),
      answered('a1', '```wumpy-run\ndocker --version\n```'),
      chip('c1', 'Ran `docker --version`'),
      handback('h1'),
      answered('a2', 'It is not installed.'),
      answered('a3', '```wumpy-run\ndocker --version\n```')
    ],
    'notification',
    'Ran `docker --version`'
  ),
  { id: 'c1', repeat: 2 }
)

check(
  'a count can keep climbing',
  N.repeatOf([chip('c1', 'Ran `dir`', { repeat: 4 })], 'notification', 'Ran `dir`'),
  { id: 'c1', repeat: 5 }
)

/* The person speaking starts the count again: a count is about repetition
   nobody is watching. Same reason the unattended-run budget resets. */
check(
  'but a question in between starts again',
  N.repeatOf(
    [chip('c1', 'Ran `dir`'), answered('a1', 'Here it is.'), said('u2', 'do it again')],
    'notification',
    'Ran `dir`'
  ),
  null
)
check(
  'and so does an aside, which is also them speaking',
  N.repeatOf(
    [
      chip('c1', 'Ran `dir`'),
      { id: 'x1', role: 'system', content: 'wait, in C:', createdAt: 1, notice: true, aside: true }
    ],
    'notification',
    'Ran `dir`'
  ),
  null
)

/* "Consecutively": a different chip in between ends the run rather than
   being skipped over, or `dir ls dir` would read as dir twice. */
check(
  'a different chip in between ends it',
  N.repeatOf(
    [chip('c1', 'Ran `dir`'), chip('c2', 'Ran `ls`')],
    'notification',
    'Ran `dir`'
  ),
  null
)

/* A notice is the model's context as well as a chip, so collapsing one saves
   the window a line too - but it must never collapse onto a receipt. */
const notice = (id, content) => ({ id, role: 'system', content, createdAt: 1, notice: true })
check(
  'notices count among themselves',
  N.repeatOf([notice('n1', 'Ran `cls` — succeeded, no output.')], 'notice', 'Ran `cls` — succeeded, no output.'),
  { id: 'n1', repeat: 2 }
)
check(
  'and never onto a receipt',
  N.repeatOf([chip('c1', 'Ran `dir`')], 'notice', 'Ran `dir`'),
  null
)
check('a receipt never counts onto a notice', N.repeatOf([notice('n1', 'Ran `dir`')], 'notification', 'Ran `dir`'), null)

/* ------------------------------------------------------ applying the repeat */

const before = [said('u1', 'list it'), chip('c1', 'Ran `dir`'), answered('a1', 'Done.')]
const after = N.collapsed(before, { id: 'c1', repeat: 3 }, 99)
check('the chip moves to the end', after.map((m) => m.id), ['u1', 'a1', 'c1'])
check('with its count', after[2].repeat, 3)
check('and a fresh time', after[2].createdAt, 99)
check('nothing else changes', after.length, before.length)
ok('and it is the same chip, not a new one', after[2].id === 'c1' && after[2].notification === true)

/* ------------------------------------------------------------ chip contents */

check('a command inside a chip is code', N.inlineCode('Ran `dir`'), [
  { code: false, text: 'Ran ' },
  { code: true, text: 'dir' }
])
check('plain text stays one piece', N.inlineCode('Did 2 steps on your screen'), [
  { code: false, text: 'Did 2 steps on your screen' }
])
check('and a stray backtick is left alone', N.inlineCode('Ran `dir'), [
  { code: false, text: 'Ran `dir' }
])
check('text after the code survives', N.inlineCode('Ran `dir` — it failed'), [
  { code: false, text: 'Ran ' },
  { code: true, text: 'dir' },
  { code: false, text: ' — it failed' }
])

/* --------------------------------------------------------------- the wiring */

/**
 * A pure rule nothing calls is a rule that does not hold.
 *
 * These are the four lines that make the feature exist, and the first one is
 * the one that matters most: the hand-back must stay unshown. Without
 * `automatic` the user gets the chip AND the bubble that the chip replaced.
 */
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
ok(
  "a command's output is sent and not shown",
  /send\(report, `Ran: \\`\$\{result\.command\}\\``, undefined, true\)/.test(app)
)
ok('a run says so in the transcript', /notify\(ranLine\(result\)\)/.test(app))
ok('a search too', /notify\(searchedLine\(query\)\)/.test(app))
ok('and the results are sent the same way', /`Searched: \$\{query\}`,\s*undefined,\s*true/.test(app))
ok('a plan of clicks too', /notify\(desktopLine\(result\)\)/.test(app))
ok('a write, a link and a screenshot as well', /notify\(wroteLine\(result\)\)/.test(app) && /notify\(openedLine\(result\)\)/.test(app) && /notify\(screenLine\(\)\)/.test(app))
/* Every receipt goes through the same door, so none of them can quietly stop
   collapsing. A note stays what it was: Wumpy answering something the user
   typed, which is also what starts a count again. */
ok(
  'and no receipt is left as a note',
  !/note\((ranLine|wroteLine|openedLine|desktopLine|screenLine)/.test(app)
)

const chat = readFileSync('src/renderer/src/hooks/useChat.ts', 'utf8')
ok('the hook offers notify', /notify\(content: string\): void/.test(chat))
ok('and returns it', /^\s{4}notify,$/m.test(chat.replace(/\r/g, '')))
ok(
  'the decision is made inside the state updater',
  /setMessages\(\(prev\) => \{\s*const again = repeatOf\(prev,/.test(chat)
)

const message = readFileSync('src/renderer/src/components/Message.tsx', 'utf8')
ok('a receipt renders as its own chip', /if \(message\.notification\)/.test(message))
ok('with the count', /repeat=\{message\.repeat\}/.test(message))
ok('both chips set code in code', (message.match(/<Chip text=/g) ?? []).length === 2)

const css = readFileSync('src/renderer/src/styles.css', 'utf8')
ok('the count has somewhere to live', /\.chip-count \{/.test(css))
ok('and a receipt is quieter than a notice', /\.notice-chip\.is-receipt \{/.test(css))

/* --------------------------------------------- the same NOTE, twice over */

/*
 * Reported with a screenshot of two identical lines back to back: "I said
 * repeating notifications spam the chat". The chips learned this and notes
 * were deliberately excluded, on the grounds that a note is the app
 * speaking rather than a receipt for an action. That exclusion was the bug.
 *
 * A note collapses rather than counts. A chip counts because the action
 * really did happen twice; a note states what is true NOW, and "Now
 * answering with X x2" would describe the state as though it had doubled.
 */
const aNote = (content, over = {}) => ({
  id: `n${Math.random()}`,
  role: 'assistant',
  content,
  createdAt: 1,
  local: true,
  ...over
})

const SAID = 'Now answering with **DeepSeek V4.1 Flash**. 39/41 on the full ladder.'
check('the same note twice running is one note', N.repeatOfNote([aNote(SAID)], SAID)?.repeat, 2)
check('a different note is not a repeat', N.repeatOfNote([aNote('Reasoning shown.')], SAID), null)
check('nor is an empty transcript', N.repeatOfNote([], SAID), null)
/* Only the line immediately before counts: once anything else has happened,
   saying it again is worth doing. */
check(
  'a note after something else is said again',
  N.repeatOfNote([aNote(SAID), { id: 'u', role: 'user', content: 'hi', createdAt: 2 }], SAID),
  null
)
check('an error is never folded in', N.repeatOfNote([aNote(SAID, { error: 'boom' })], SAID), null)
check(
  'nor is a question',
  N.repeatOfNote([aNote(SAID, { localAsk: { question: 'q', options: [], kind: 'rename' } })], SAID),
  null
)
check(
  'nor a chip, which counts instead',
  N.repeatOfNote([aNote(SAID, { notification: 'run' })], SAID),
  null
)
{
  const before = [aNote(SAID)]
  const after = N.collapsed(before, N.repeatOfNote(before, SAID), 9)
  check('one line survives the collapse', after.length, 1)
  check('and it is the same one, moved to the end', after[0].id, before[0].id)
}

/* ------------------------------------------- one statement, said once */

/**
 * The same subject twice, in different words.
 *
 * Reported with a screenshot of nine paragraphs: three presses of Shift+Tab
 * had put "Manual", then "Auto", then "Accept all" in the transcript, three
 * times over, all of them about the one setting and two in three wrong by
 * the time they were read. "since they fall under the same command or
 * effect, just replace, not add".
 *
 * The repeat rule above could not help - it is the same WORDS twice, and
 * these are three different sentences about one fact.
 */
const MANUAL = '**Manual** — every command waits for you.'
const ALL = '**Accept all** — commands run without asking.'
const states = (content, topic, over = {}) => aNote(content, { topic, ...over })

check(
  'a second statement replaces the first',
  N.restatementOf([states(MANUAL, 'approve')], 'approve') !== null,
  true
)
check('a different subject does not', N.restatementOf([states(MANUAL, 'approve')], 'pin'), null)
check('nor does an untagged note', N.restatementOf([aNote(MANUAL)], 'approve'), null)
check('nor an empty transcript', N.restatementOf([], 'approve'), null)
/*
 * Anything in between is skipped rather than stopped at, which is the
 * difference between this and the chip rule. A statement of state is about
 * NOW, so a stale one must not survive because Wumpy said something else
 * after it - and a note about something else is a second current fact, not a
 * wall.
 */
check(
  'Wumpy talking in between does not save the stale one',
  N.restatementOf([states(MANUAL, 'approve'), aNote('Ran something.')], 'approve') !== null,
  true
)
check(
  'and neither does a statement about something else',
  N.restatementOf([states(MANUAL, 'approve'), states('Pinned.', 'pin')], 'approve') !== null,
  true
)
/* The person speaking ends it: what was true before is part of the
   conversation they are reading back. The same line repeatOf draws. */
check(
  'but the person speaking does',
  N.restatementOf(
    [states(MANUAL, 'approve'), { id: 'u', role: 'user', content: 'hi', createdAt: 2 }],
    'approve'
  ),
  null
)
/* An automatic turn is the app handing something to the model, not the
   person saying anything. */
check(
  'a hand-back is not the person speaking',
  N.restatementOf(
    [
      states(MANUAL, 'approve'),
      { id: 'a', role: 'user', content: 'here is the screenshot', createdAt: 2, automatic: true }
    ],
    'approve'
  ) !== null,
  true
)
{
  const before = [states(MANUAL, 'approve'), aNote('Ran something.')]
  const after = N.restated(before, N.restatementOf(before, 'approve'), ALL, 9)
  check('nothing is added', after.length, before.length)
  check('it says the new thing', after[after.length - 1].content, ALL)
  check('it is still the same note', after[after.length - 1].id, before[0].id)
  /* Moved to the end, because at the bottom it reads as the current state
     and halfway up it reads as history. */
  check('and it is the last thing said', after[after.length - 1].topic, 'approve')
  check('the other line is untouched', after[0].content, 'Ran something.')
}

/**
 * And a report is a statement too.
 *
 * `/log` typed twice put two copies of a twenty-line block in the
 * transcript, the first of them already out of date by the second - the
 * entries it was printed from had changed in between. "here, I typed /log
 * twice".
 *
 * liveNote is the awkward one: it hands an id back to the caller, which is
 * what the subscription rewrites the report by, so the decision cannot be
 * made inside the updater the way `note` makes it.
 */
ok('a live report can have a subject', /liveNote = useCallback\(\s*\(content: string, topic\?/.test(chat))
ok('and reuses the one it replaces', /const id = earlier \?\? nextId\(\)/.test(chat))
/* If the note it meant to replace has gone - a new chat, a reopened one -
   it appends instead, rather than returning an id that is not on screen. */
ok('with a fallback when it has gone', /prev\.some\(\(m\) => m\.id === earlier\)/.test(chat))
ok('/log is one of them', /journalLines\(entries, view\)\.join\(NEWLINE\), 'journal'/.test(app))

/* And so is every other report, because every one of them is a snapshot of
   how things are right now. A second copy under the first is a page of
   transcript saying what the page above it said, with the older one wrong in
   whatever has changed since. */
{
  /* Whitespace removed: the argument is on its own line in some of these
     and inline in others, depending on how long the report's expression is,
     and the check is about which calls carry a subject rather than how
     Prettier broke the line. */
  const flat = app.replace(/\s+/g, '')
  for (const topic of ['settings', 'usage', 'rank', 'probe', 'help', 'shortcuts']) {
    ok(`the ${topic} report replaces itself`, flat.includes(`false,'${topic}'`))
  }
}

ok('note() asks before appending', /repeatOfNote\(prev, content\)/.test(chat))
ok('and asks about the subject first', /restatementOf\(prev, topic\)/.test(chat))
ok('a new note carries its subject', /local: true,\n\s*topic\n/.test(chat))
/* The reported one. A mode that cycles three ways from one key is the note
   most likely to be said several times in a row. */
ok('the approval mode is one of them', /APPROVAL_NOTE\[next\], false, 'approve'/.test(app))
/* Two routes to the same fact - the command and the header button - so they
   have to agree about what it is a statement about, or Ctrl+P and /pin
   stack up against each other. */
ok('both ways of pinning are the same subject', (app.match(/'pin'\n/g) ?? []).length >= 2)
/* The cause, not just the safety net: picking the model already in use is a
   confirmation, and announcing a change that did not happen is the spam. */
ok('picking the current model says nothing', /if \(name === current\) \{/.test(app))
ok('and typing it says "already" instead', /Already answering with/.test(app))

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of`} notification checks`)
process.exit(failures === 0 ? 0 : 1)

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

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of`} notification checks`)
process.exit(failures === 0 ? 0 : 1)

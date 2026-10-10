/**
 * Checks the command table itself.
 *
 * Everything the app can do is reachable three ways — typed as `/name`, picked
 * from the Ctrl+K menu, and listed by `/help` — and all three read the same
 * table. These assertions are about the table staying coherent: no name that
 * shadows another, no keyboard hint pointing at a command that no longer
 * exists, and nothing in the menu that cannot actually be run from it.
 *
 * Run with: npm run check:commands
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.commands-check.mjs')
await build({
  entryPoints: ['src/renderer/src/commands.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const { allCommands, findCommand, parseCommand, completions, helpText, SHORTCUT_FOR } =
  await import(pathToFileURL(out).href)

const commands = allCommands()
let failed = 0
const fail = (msg) => {
  failed++
  console.log(`FAIL ${msg}`)
}

/* ------------------------------------------------------------ the table */

const seen = new Map()
for (const c of commands) {
  for (const name of [c.name, ...(c.aliases ?? [])]) {
    if (seen.has(name)) fail(`/${name} is claimed by both /${seen.get(name)} and /${c.name}`)
    seen.set(name, c.name)
  }
  if (!c.hint?.trim()) fail(`/${c.name} has no description, so the menu shows a blank row`)
}
console.log(`ok   ${commands.length} commands, ${seen.size} names, none shadowed`)

/* ------------------------------- every route to a command finds the same one */

for (const c of commands) {
  for (const name of [c.name, ...(c.aliases ?? [])]) {
    if (findCommand(name)?.name !== c.name) fail(`findCommand('${name}') missed /${c.name}`)
    if (!completions(`/${name}`).some((x) => x.name === c.name)) {
      fail(`typing /${name} does not offer /${c.name}`)
    }
  }
}
console.log('ok   every name and alias resolves, and completes')

/* ------------------------------------------------- the menu can run them all */

/**
 * Picking from the menu runs the command with no argument and looks at what
 * comes back: an error means it genuinely needs text, and the composer is
 * filled in instead. So the only unusable command is one that takes no
 * argument and still errors - there is then nothing the menu could do with it.
 *
 * Several commands take an argument and are still fine without one: /tier
 * opens the tier list, /pin toggles. Those run straight from the menu, which
 * is why this does not simply branch on `arg`.
 */
let runnable = 0
let needsText = 0
for (const c of commands) {
  const action = c.run('')
  if (action.kind === 'error') {
    needsText++
    if (!c.arg) fail(`/${c.name} takes no argument and still errors: ${action.message}`)
  } else {
    runnable++
  }
}
console.log(`ok   ${runnable} commands run straight from the menu, ${needsText} ask for text first`)

/* ------------------------------------------------------- the keyboard hints */

for (const name of Object.keys(SHORTCUT_FOR)) {
  if (!findCommand(name)) fail(`SHORTCUT_FOR has a key for /${name}, which does not exist`)
}
console.log(`ok   ${Object.keys(SHORTCUT_FOR).length} keyboard hints point at real commands`)

/* ------------------------------------------------------------------- /help */

const help = helpText()
for (const c of commands) {
  if (!help.includes(`/${c.name}`)) fail(`/help does not mention /${c.name}`)
}
for (const key of ['Ctrl+K', 'Ctrl+N', 'Ctrl+R', 'Ctrl+D', 'Shift+Tab', 'PageUp', 'Esc']) {
  if (!help.includes(key)) fail(`/help does not mention ${key}`)
}
console.log('ok   /help lists every command and every key')

/* -------------------------------------------------------------- the parser */

const PARSES = [
  ['/new', 'new'],
  ['/NEW', 'new'],
  ['  /new  ', 'new'],
  ['/rename maths', 'rename'],
  ['/nonsense', 'error'],
  ['not a command', null],
  ['/', null]
]
for (const [input, want] of PARSES) {
  const got = parseCommand(input)
  const kind = got === null ? null : got.kind
  if (kind !== want) fail(`parseCommand(${JSON.stringify(input)}) gave ${kind}, wanted ${want}`)
}
console.log(`ok   ${PARSES.length} lines parse as expected`)

/* ------------------------------------- Tab completes, Enter runs -------- */

/**
 * Reported as "you have to press enter and then enter again".
 *
 * The palette completed on Enter for anything that took an argument at all,
 * so `/model` became `/model ` with a trailing space and waited for a name —
 * and the picker it was going to open anyway needed a second Enter. Only a
 * command that is genuinely useless bare should ask for the argument first.
 *
 * The test is not what the flag says; it is whether the bare command does
 * something. Every command marked as needing one must answer bare with an
 * error, and every command NOT marked must answer bare with something else.
 * Add a command later whose bare form stops working and this says so.
 */
const BARE_IS_USELESS = [
  'rename',
  'open',
  'key',
  // The prompt wrappers: all six wrap something the user writes, and have
  // nothing to wrap without it.
  'plan',
  'btw',
  'explain',
  'fix',
  'review',
  'cmd'
]
for (const spec of commands) {
  if (!spec.arg) continue
  const bare = spec.run('')
  const useless = bare?.kind === 'error'
  const marked = spec.argRequired === true
  if (useless !== marked) {
    fail(
      `/${spec.name}: argRequired is ${marked ? 'set' : 'not set'}, but bare it ` +
        `${useless ? 'only prints its usage' : `does something (${bare?.kind})`}`
    )
  }
  if (marked && !BARE_IS_USELESS.includes(spec.name)) {
    fail(`/${spec.name} newly needs an argument — is that right, or does bare have a job?`)
  }
}
console.log(`ok   ${BARE_IS_USELESS.length} commands need their argument, the rest run bare`)

/* The three named ones are exactly the three, in both directions. */
for (const name of BARE_IS_USELESS) {
  const spec = findCommand(name)
  if (!spec) fail(`/${name} is gone from the table`)
  else if (spec.argRequired !== true) fail(`/${name} no longer asks for its argument`)
}

/** The ones the report was actually about. */
for (const name of ['model', 'usage', 'pin', 'reasoning', 'dock', 'remember']) {
  const spec = findCommand(name)
  if (!spec) fail(`/${name} is gone from the table`)
  else if (spec.argRequired) fail(`/${name} would make the user press Enter twice again`)
}

rmSync(out, { force: true })

console.log(failed === 0 ? '\nall command checks correct' : `\n${failed} command checks FAILED`)
process.exit(failed === 0 ? 0 : 1)

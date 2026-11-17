/**
 * Notes it saves itself, and skills.
 *
 * Asked for in these words: "Can I hold like local memory kind of? Like
 * local skills like Claude." The notes file already existed but only
 * `/remember` could write to it; now the model can, with a tag that is
 * saved and shown. Skills are instruction files the user owns, listed in a
 * line each turn and sent whole once the conversation turns to them.
 *
 * The store runs for real against a temporary folder, through a stub for
 * electron's userData path, as check-context does.
 *
 * Run with: node scripts/check-skills.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const dir = mkdtempSync(join(tmpdir(), 'wumpy-skills-'))
const shim = join(dir, 'electron.mjs')
writeFileSync(shim, `export const app = { getPath: () => ${JSON.stringify(dir)} }${NL}`)

async function load(entry, name) {
  const out = join(process.cwd(), `.skills-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    alias: { electron: shim, '@shared': './src/shared' }
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${JSON.stringify(got)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}
const read = (f) => readFileSync(f, 'utf8')

const K = await load('src/shared/kept.ts', 'kept')
const S = await load('src/shared/skills.ts', 'shared')
const { SkillStore } = await load('src/main/skills.ts', 'store')
const { ContextStore } = await load('src/main/context.ts', 'context')

/* ------------------------------------------------------------ the tags */

const answer =
  'Noted — celsius from now on.<remember>They prefer celsius.</remember>' +
  '<skill name="Hangman" triggers="hangman, guess the word" description="Playing hangman out loud">' +
  'Pick a word of 5 to 8 letters and keep it in a keep note.</skill>'
check('the reply is shown and said without its tags', K.withoutKept(answer), 'Noted — celsius from now on.')
check('a fact to remember is found', K.savesIn(answer).remember, ['They prefer celsius.'])
check('and a skill, with its name, triggers and description', K.savesIn(answer).skills, [
  { name: 'Hangman', description: 'Playing hangman out loud', triggers: ['hangman', 'guess the word'], body: 'Pick a word of 5 to 8 letters and keep it in a keep note.' }
])
check('a tag still being written is hidden', K.withoutKept('Got it.<remember>They like t'), 'Got it.')
check('and so is one cut off before its ">"', K.withoutKept('Got it. <skill name="ha'), 'Got it. ')
check('but a "<" in an answer is not a tag', K.withoutKept('So 3 < 4'), 'So 3 < 4')
check('a cut-off tag saves nothing', K.savesIn('Sure.<remember>They like t').remember, [])
check('an empty skill is a removal', K.savesIn('<skill name="hangman"></skill>').skills[0].body, '')

/* ------------------------------------------------------------- skills */

check('a name is a file name on every system', S.skillName('Hangman Rules!'), 'hangman-rules')
const parsed = S.parseSkill('x', ['---', 'name: hangman', 'description: Playing hangman', 'triggers: hangman, guess the word', '---', 'Pick a word.'].join(NL))
check('a skill file is read', parsed, { name: 'hangman', description: 'Playing hangman', triggers: ['hangman', 'guess the word'], body: 'Pick a word.' })
check('one written by hand, with no header, is too', S.parseSkill('summaries', '# How I like summaries' + NL + 'Three bullets.'), {
  name: 'summaries', description: 'How I like summaries', triggers: ['summaries'], body: '# How I like summaries' + NL + 'Three bullets.'
})
check('and what is written reads back the same', S.parseSkill('x', S.skillFile(parsed)), parsed)

const skills = [parsed, S.parseSkill('summaries', 'Three bullets, no intro.')]
check('it comes into use when it is mentioned', S.activeSkills(skills, ['lets play hangman']).map((s) => s.name), ['hangman'])
check('and stays for the rest of the game', S.activeSkills(skills, ['lets play hangman', 'is there an E?', 'O']).map((s) => s.name), ['hangman'])
check('a phrase trigger, as words', S.activeSkills(skills, ['can we play guess the word']).map((s) => s.name), ['hangman'])
check('not inside another word', S.activeSkills(skills, ['the hangmanship']).map((s) => s.name), [])
check('nothing is in use until it comes up', S.activeSkills(skills, ['what is the weather']).map((s) => s.name), [])
check('the newest mentioned first', S.activeSkills(skills, ['hangman', 'give me summaries']).map((s) => s.name), ['summaries', 'hangman'])
{
  const quiet = S.skillFacts(skills, ['what is the weather'], '/x')
  check('every turn: one line, naming each', quiet.length === 1 && /hangman \(Playing hangman\); summaries/.test(quiet[0]), true)
  const playing = S.skillFacts(skills, ['lets play hangman'], '/x')
  check('in use: the whole of it', playing.some((l) => /Skill "hangman" is in use/.test(l)) && playing.some((l) => l.trim() === 'Pick a word.'), true)
  check('how to make one, only when skills are talked about', S.skillFacts(skills, ['make a skill for chess'], '/x').some((l) => l.includes('<skill name="short-name"')), true)
  check('and not otherwise', playing.some((l) => l.includes('<skill name="short-name"')), false)
  check('no skills and no asking: nothing at all', S.skillFacts([], ['hello'], '/x'), [])
}

/* ------------------------------------------------- the folder, for real */

const store = new SkillStore()
check('no folder yet: no skills', store.list(), [])
check('a skill is saved', store.save({ name: 'Hangman', description: 'Playing hangman out loud', triggers: ['Hangman'], body: 'Pick a word.' }).did, 'saved')
check('as a file they can open', existsSync(join(dir, 'skills', 'hangman.md')), true)
check('and read back', store.list().map((s) => [s.name, s.description, s.triggers, s.body]), [['hangman', 'Playing hangman out loud', ['hangman'], 'Pick a word.']])
check('the same name replaces it', store.save({ name: 'hangman', body: 'Pick a longer word.' }).did, 'replaced')
check('with what was asked', store.list()[0].body, 'Pick a longer word.')
check('it reaches the facts when it comes up', store.forPrompt(['play hangman']).some((l) => l.includes('Pick a longer word.')), true)
check('an empty one removes it', store.save({ name: 'hangman', body: '' }).did, 'removed')
check('and the file is gone', existsSync(join(dir, 'skills', 'hangman.md')), false)
check('a nameless skill is refused', store.save({ name: '!!', body: 'x' }).ok, false)

/* ------------------------------------------------------------ notes */

const notes = new ContextStore()
notes.add('They prefer celsius.')
notes.add('they prefer Celsius')
check('a fact said twice is kept once', notes.read(), '- They prefer celsius.')

/* ----------------------------------------------------------- wiring */

const main = read('src/main/index.ts')
const chat = read('src/renderer/src/hooks/useChat.ts')
const assistant = read('src/shared/assistant.ts')
check('skills reach the facts, from what they said in the chat', /\.\.\.\(skills\?\.forPrompt\(said\) \?\? \[\]\)/.test(main) && /req\.messages\.filter\(\(m\) => m\.role === 'user'\)/.test(main), true)
check('saved when the answer is finished, not before', /if \(written\.current\.id === d\.requestId\) void keepSaves\(written\.current\.text, noteRef\.current\)/.test(chat), true)
check('and every save is said', /Saved to your notes: /.test(read('src/renderer/src/saves.ts')) && /the skill /.test(read('src/renderer/src/saves.ts')), true)
check('the model is told how, when it is about remembering', /put <remember>one short fact<\/remember> anywhere in your reply/.test(assistant), true)
check('never secrets', /never for passwords or keys/.test(assistant), true)
/* "Got it - celsius it is", and nothing kept: the rule far up in the
   instructions was not enough, so it is said again beside the message. */
check('and reminded beside the message that asks', /\.\.\.\(asksToKeep\(said\[said\.length - 1\] \?\? ''\)/.test(main), true)
{
  const N = await load('src/shared/needs.ts', 'needs')
  check('"remember that I prefer celsius" asks to keep', N.asksToKeep('remember that I prefer celsius'), true)
  check('"from now on, answer short" does too', N.asksToKeep('from now on, answer short'), true)
  check('"what is the weather" does not', N.asksToKeep('what is the weather'), false)
}

rmSync(dir, { recursive: true, force: true })
console.log(`${NL}${failed === 0 ? 'all' : `${failed} FAILED of the`} skill checks${failed ? '' : ' correct'}`)
process.exit(failed ? 1 : 0)

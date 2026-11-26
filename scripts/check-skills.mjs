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

/* ---------------------------------------------------------- hangman */

/* "Yes, there's an E. It's the fifth letter: _ _ _ E _ _" - measured on
   Nemotron 3.5 Super. The board is worked out here instead. */
{
  const H = await load('src/shared/hangman.ts', 'hangman')
  for (const [said, want] of [
    ['is there an E?', 'E'], ['E', 'E'], ['is there an oh?', 'O'], ['you', 'U'], ['The letter see.', 'C'],
    ['are there any e\'s', 'E'], ['what about T', 'T'], ['a', 'A'], ['Okay, is there a why?', 'Y'],
    ['you pick the word', null], ['is it planet?', null], ['what is the weather', null]
  ]) check(`"${said}" guesses ${want}`, H.guessIn(said), want)
  const game = [
    { role: 'user', content: "let's play hangman, you pick the word" },
    { role: 'assistant', content: '<keep>WORD: PLANET. Letters: 1 P, 2 L, 3 A, 4 N, 5 E, 6 T.</keep>I have a six-letter word.' },
    { role: 'user', content: 'is there an E?' },
    { role: 'assistant', content: 'Yes.' },
    { role: 'user', content: 'is there an oh?' },
    { role: 'assistant', content: 'No.' },
    { role: 'user', content: 'is there an A?' }
  ]
  const s = H.hangmanState(game)
  check('the word comes from the note', s?.word, 'PLANET')
  check('the board is right where the model was not', s?.board, '_ _ A _ E _')
  check('and the misses are counted', s?.misses, ['O'])
  const facts = H.hangmanFacts(game).join(' ')
  check('the model is told the board, to show as given', /their guess is A, which is in it, at place 3/.test(facts) && /The board is now "_ _ A _ E _"/.test(facts), true)
  check('nothing on a turn that is not a guess', H.hangmanFacts([...game.slice(0, 6), { role: 'user', content: 'what is the weather' }]), [])
  check('nothing with no word in a note', H.hangmanFacts([{ role: 'user', content: 'E' }]), [])
  check('a new game, a new word', H.hangmanState([...game, { role: 'assistant', content: '<keep>word: tiger</keep>New game.' }, { role: 'user', content: 'E' }])?.board, '_ _ _ E _')
  check('and it reaches the facts', /\.\.\.hangmanFacts\(messages\.map/.test(read('src/main/index.ts')), true)
}

/* ------------------------------------------------- the folder, for real */

const B = await load('src/shared/builtinskills.ts', 'builtin')
const store = new SkillStore()
const shippedNames = Object.keys(B.BUILTIN_SKILLS).sort()
const mine = () => store.list().filter((s) => !shippedNames.includes(s.name))
check('a new folder starts with the shipped skills', store.list().map((s) => s.name), shippedNames)
check('each in a folder of its own, as Claude lays them out', shippedNames.every((n) => existsSync(join(dir, 'skills', n, 'SKILL.md'))), true)
check('and none of theirs yet', mine(), [])
check('a skill is saved', store.save({ name: 'Hangman', description: 'Playing hangman out loud', triggers: ['Hangman'], body: 'Pick a word.' }).did, 'saved')
check('as a file they can open, in its own folder', existsSync(join(dir, 'skills', 'hangman', 'SKILL.md')), true)
check('and read back', mine().map((s) => [s.name, s.description, s.triggers, s.body]), [['hangman', 'Playing hangman out loud', ['hangman'], 'Pick a word.']])
check('the same name replaces it', store.save({ name: 'hangman', body: 'Pick a longer word.' }).did, 'replaced')
check('with what was asked', store.get('hangman')?.body, 'Pick a longer word.')
check('it reaches the facts when it comes up', store.forPrompt(['play hangman']).some((l) => l.includes('Pick a longer word.')), true)
check('an empty one removes it', store.save({ name: 'hangman', body: '' }).did, 'removed')
check('and the file and its folder are gone', existsSync(join(dir, 'skills', 'hangman')), false)
writeFileSync(join(dir, 'skills', 'summaries.md'), 'Three bullets, no intro.')
check('a single <name>.md, as Wumpy first wrote them, still reads', store.get('summaries')?.body, 'Three bullets, no intro.')
store.save({ name: 'summaries', body: 'Four bullets.' })
check('and is changed where it is', readFileSync(join(dir, 'skills', 'summaries.md'), 'utf8').includes('Four bullets.'), true)
check('a skill can carry its argument hint', store.save({ name: 'standup', body: 'Write my standup from: $ARGUMENTS', argumentHint: '<what I did>' }).ok && store.get('standup')?.argumentHint, '<what I did>')
{
  const sums = store.summaries()
  check('the panel is told which are built in', sums.filter((x) => x.builtin).map((x) => x.name), shippedNames)
  check('and which are theirs', sums.filter((x) => !x.builtin).map((x) => x.name).sort(), ['standup', 'summaries'])
  check('every one a command unless it says otherwise', sums.every((x) => x.command), true)
}

/* The shipped skills: kept when changed, updated when not, gone when deleted. */
{
  const record = () => JSON.parse(readFileSync(join(dir, 'skills', '.builtin.json'), 'utf8'))
  const grillFile = join(dir, 'skills', 'grill', 'SKILL.md')
  writeFileSync(grillFile, readFileSync(grillFile, 'utf8') + '\nAlways ask about money first.\n')
  check('a shipped skill they changed is theirs', store.summaries().find((x) => x.name === 'grill')?.builtin, false)
  /* A newer Wumpy with a different grill and eli5 still as shipped. */
  const rec = record()
  rec.grill = 'oldhash'
  rec.eli5 = (await import('node:crypto')).createHash('sha256').update(readFileSync(join(dir, 'skills', 'eli5', 'SKILL.md'), 'utf8')).digest('hex').slice(0, 16)
  const eli5Before = readFileSync(join(dir, 'skills', 'eli5', 'SKILL.md'), 'utf8')
  writeFileSync(join(dir, 'skills', 'eli5', 'SKILL.md'), eli5Before.replace('# Explain', '# OLD Explain'))
  rec.eli5 = (await import('node:crypto')).createHash('sha256').update(readFileSync(join(dir, 'skills', 'eli5', 'SKILL.md'), 'utf8')).digest('hex').slice(0, 16)
  writeFileSync(join(dir, 'skills', '.builtin.json'), JSON.stringify(rec))
  rmSync(join(dir, 'skills', 'humanize'), { recursive: true, force: true })
  const again = new SkillStore()
  again.list()
  check('an untouched shipped skill is brought up to date', readFileSync(join(dir, 'skills', 'eli5', 'SKILL.md'), 'utf8'), B.BUILTIN_SKILLS.eli5)
  check('a changed one is left exactly as they made it', /Always ask about money first/.test(readFileSync(grillFile, 'utf8')), true)
  check('and a deleted one stays deleted', existsSync(join(dir, 'skills', 'humanize')), false)
}

/* As commands. */
{
  const grill = S.parseSkill('grill', B.BUILTIN_SKILLS.grill)
  check('Claude\'s header fields are read', [grill.argumentHint, grill.auto, grill.command], ['<plan, idea or decision>', undefined, undefined])
  const p = S.skillPrompt(grill, 'move to Berlin in March')
  check('$ARGUMENTS takes what followed the command', /until we both understand it completely: move to Berlin in March/.test(p) && !/\$ARGUMENTS/.test(p), true)
  check('the instructions travel in the message, to last the whole task', /<instructions skill="grill">[\s\S]*<\/instructions>/.test(p) && /rest of this task/.test(p), true)
  const plain = S.parseSkill('standup', 'Write it as three bullets.')
  check('without $ARGUMENTS they go at the end, as in Claude', S.skillPrompt(plain, 'fixed the login bug').endsWith('ARGUMENTS: fixed the login bug'), true)
  check('and with nothing given it asks', /ask me for it in one short question/.test(S.skillPrompt(plain, '')), true)
  const only = S.parseSkill('x', ['---', 'name: deploy', 'description: "Deploy the site"', 'disable-model-invocation: true', '---', 'Deploy.'].join(NL))
  check('quoted descriptions are read as YAML has them', only.description, 'Deploy the site')
  check('disable-model-invocation: only ever run as a command', [only.auto, S.activeSkills([only], ['deploy it']).length], [false, 0])
  check('user-invocable: false is not a command', S.parseSkill('x', ['---', 'name: tone', 'user-invocable: false', '---', 'Warm.'].join(NL)).command, false)
  check('and both survive being written back', S.parseSkill('x', S.skillFile(only)).auto, false)
  check('a trigger brings a shipped skill in by itself', S.activeSkills([grill], ['can you grill me on this']).map((s) => s.name), ['grill'])
  check('with $ARGUMENTS read as what they asked', S.skillFacts([grill], ['grill me on my plan'], '/x').some((l) => /understand it completely: what they asked about/.test(l)), true)
  check('every shipped skill fits', Object.values(B.BUILTIN_SKILLS).every((t) => S.parseSkill('x', t).body.length <= S.MAX_SKILL_CHARS), true)
  check('every shipped skill has Claude\'s fields', Object.entries(B.BUILTIN_SKILLS).every(([n, t]) => { const k = S.parseSkill('x', t); return k.name === n && /\bUse when\b/.test(k.description) && Boolean(k.argumentHint) }), true)
  check('a long description is cut to what it says', S.shortly(B.BUILTIN_SKILLS.grill.match(/description: (.*)/)[1]), 'Grill me on a plan, idea or decision')
  {
    const shipped = Object.values(B.BUILTIN_SKILLS).map((t) => S.parseSkill('x', t))
    /* Ordinary chat must not pull a skill in for the rest of the conversation. */
    for (const said of ['should I use postgres or sqlite', 'it doesn\'t work when I click it', 'teach me about black holes', 'help me understand this error', 'write an announcement for the team', 'this needs to sound natural', 'what is the weather'])
      check(`"${said}" brings in no skill`, S.activeSkills(shipped, [said]).map((k) => k.name), [])
    for (const [said, want] of [['grill me on this plan', 'grill'], ["explain like i'm five", 'eli5'], ['can you humanize this', 'humanize'], ['help me decide between these', 'decide'], ['make a skill for my standups', 'skill-creator'], ['tldr please', 'tldr'], ['proofread this', 'proofread'], ['quiz me on French verbs', 'tutor']])
      check(`"${said}" brings in ${want}`, S.activeSkills(shipped, [said]).map((k) => k.name), [want])
  }
  check('a skill tag can carry an argument hint', K.savesIn('<skill name="a" argument-hint="<topic>">Do it.</skill>').skills[0].argumentHint, '<topic>')
}
{
  const cmds = read('src/renderer/src/commands.ts')
  const app = read('src/renderer/src/App.tsx')
  check('skills join the command list', /return skillSpecs\.length \? \[\.\.\.COMMANDS, \.\.\.skillSpecs\] : COMMANDS/.test(cmds) && /return allCommands\(\)\.find\(\(c\) => matches\(c, n\)\)/.test(cmds), true)
  check('but never take over one of the app\'s own', /!taken\.has\(s\.name\)/.test(cmds), true)
  check('/skill <name> runs one anyway', /name: 'skill',/.test(cmds), true)
  check('a skill command sends the skill, showing what was typed', /chat\.send\(skillPrompt\(skill, action\.args\), shown\)/.test(app), true)
  check('the list is read when the panel comes up', /refresh\(\)\s*const offShown = window\.wumpy\.panel\.onShown\(refresh\)/.test(app), true)
  check('and when a chat saves one', /if \(skills\.length\) void window\.wumpy\.skills\.list\(\)\.then\(setSkillCommands\)/.test(read('src/renderer/src/saves.ts')), true)
  check('the palette hears about them', /useSyncExternalStore\(onCommandsChanged, commandsSeen\)/.test(read('src/renderer/src/components/Composer.tsx')), true)
}

/* ---------------------------------------- asking it to make one */
{
  const out = join(process.cwd(), '.skills-intents.mjs')
  await build({ entryPoints: ['src/renderer/src/intents.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { '@shared': './src/shared' } })
  const { matchIntent } = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  for (const [said, ask] of [
    ['make a skill for my standups', 'new for my standups'],
    ['create your own skill to check the weather every morning', 'new to check the weather every morning'],
    ['Write yourself a skill that turns my notes into flashcards.', 'new that turns my notes into flashcards'],
    ['can you create a new skill called standup', 'new called standup'],
    ['make a skill: summarise my emails', 'new summarise my emails'],
    ['create a skill', 'new'],
    ['create a skill for yourself', 'new'],
    ['save that as a skill', 'new from this conversation: the way we just did it'],
    ['turn what we just did into a skill called weekly-report', 'new from this conversation: the way we just did it, named weekly-report'],
    ['make this conversation into your own skill', 'new from this conversation: the way we just did it']
  ]) check(`"${said}" makes a skill`, matchIntent(said), { kind: 'skills', ask })
  for (const said of ['make a skill tree for my game', 'what skills do you have?', 'I need to learn a new skill', 'create a skillset matrix'])
    check(`"${said}" is for the model`, matchIntent(said)?.kind ?? null, null)
  const app = read('src/renderer/src/App.tsx')
  check('with nothing said, skill-creator asks what it should do', /if \(!what && !creator\) \{/.test(app), true)
  const creator = B.BUILTIN_SKILLS['skill-creator']
  check('skill-creator makes skills for Wumpy itself too', /A skill for yourself/.test(creator) && /for Wumpy itself/.test(creator), true)
  check('saved only by the tag, never by writing the file', /The only way to save a skill is this tag/.test(creator) && /Do not write a file/.test(creator), true)
  check('and from what was just done, without asking again', /## From this conversation/.test(creator) && /Do not ask me to describe it again/.test(creator), true)
  const shipped = Object.values(B.BUILTIN_SKILLS).map((t) => S.parseSkill('x', t))
  check('"create your own skill" brings skill-creator in when it reaches the model', S.activeSkills(shipped, ['could you create your own skill for my morning routine, with the weather and my calendar?']).map((k) => k.name), ['skill-creator'])
  check('"yes" to "save that as a skill?" still gets the format', S.skillFacts(shipped, ['yes'], '/x', 'Want me to save that as a skill?').some((l) => l.includes('<skill name="short-name"')), true)
  check('a skill command is not talk about skills', S.skillFacts(shipped, [S.skillPrompt(shipped[0], 'x')], '/x').some((l) => l.includes('<skill name="short-name"')), false)
  check('the model is told it can make them', S.skillFacts(shipped, ['hello'], '/x')[0].includes('You can make new ones, for them or for yourself'), true)
}

/* ------------------------------------------------------------ notes */

const notes = new ContextStore()
notes.add('They prefer celsius.')
notes.add('they prefer Celsius')
check('a fact said twice is kept once', notes.read(), '- They prefer celsius.')

/* ----------------------------------------------------------- wiring */

const main = read('src/main/index.ts')
const chat = read('src/renderer/src/hooks/useChat.ts')
const assistant = read('src/shared/assistant.ts')
check('skills reach the facts, from what they said in the chat', /\.\.\.\(skills\?\.forPrompt\(said, lastReplyOf\(messages\)\) \?\? \[\]\)/.test(main) && /const said = messages\.filter\(\(m\) => m\.role === 'user'\)/.test(main), true)
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

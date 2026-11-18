/**
 * Choosing out loud, and the model running Wumpy's own commands.
 *
 * Asked for in these words: "when I say slash model, it's going to tell me
 * quickly... the top three overall for balanced, and then the smartest and
 * the fastest... and then when I say it, it's going to roughly estimate
 * which model I'm trying to link to. If I just say Nemotron, then it's going
 * to preview all of the Nemotrons ranked." And: "I can ask the AI to run...
 * an actual command in the chat... delete this chat. And then it's going to
 * tell me, are you sure you want to delete this chat?" And: "when I'm using
 * Wumpy, turn off the background music too."
 *
 * The matching is checked against the real catalogue, with the words a
 * recogniser actually writes - "Jemma", "deep seek", "five point three" -
 * and the rest is checked as wiring, since a microphone is not available to
 * a script.
 *
 * Run with: node scripts/check-spokenpick.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.spokenpick-${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}

const P = await load('src/shared/spokenpick.ts', 'pick')
const C = await load('src/shared/cloud.ts', 'cloud')
const O = await load('src/shared/order.ts', 'order')
const I = await load('src/renderer/src/intents.ts', 'intents')
const K = await load('src/renderer/src/commands.ts', 'commands')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}
const read = (f) => readFileSync(f, 'utf8')

/* ------------------------------------------------------ naming a model */

const ranked = O.rankedModels(C.CLOUD_MODELS, {}, 'balanced')
  .slice()
  .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  .map((r) => r.model)
const options = ranked.map((m) => ({ id: m.id, names: [m.label, m.id] }))
const labels = (heard) => P.matchSpoken(heard, options).map((id) => C.CLOUD_MODELS.find((m) => m.id === id).label)
const nemotrons = ranked.filter((m) => /nemotron/i.test(m.label)).map((m) => m.label)

check('"Nemotron" is every Nemotron, best first', labels('Nemotron'), nemotrons)
check('more than one of them, or this proves nothing', nemotrons.length > 1, true)
check('"nemotron super" is the one', labels('nemotron super'), ['Nemotron 3.5 Super VL 120B'])
check('"Nemotron Ultra" is the one', labels('Nemotron Ultra'), ['Nemotron 3 Ultra 550B'])
check('"the nemotron 30B" is the two that are 30B', labels('the nemotron 30B').length, 2)
check('misheard: "Jemma" is Gemma', labels('Jemma'), ['Gemma 4 31B (Ollama cloud)'])
check('split: "deep seek" is DeepSeek', labels('deep seek'), ['DeepSeek V4.1 Flash'])
check('spelled out: "GLM five point three" is GLM 5.3 Flash', labels('GLM five point three'), ['GLM 5.3 Flash'])
/* Two names where one is the start of the other - GLM 5.3 and its Flash
   were, until NVIDIA withdrew GLM 5.3 on 15 Nov - so made up here. */
const pair = [
  { id: 'big', names: ['GLM 5.3'] },
  { id: 'flash', names: ['GLM 5.3 Flash'] }
]
check('named in full beats a longer name', P.matchSpoken('GLM 5.3', pair), ['big'])
check('"GLM" alone is both', P.matchSpoken('GLM', pair).length, 2)
check('"step fun" is StepFun', labels('step fun'), ['StepFun Step 5 600B'])
check('a whole sentence around the name', labels('switch to the gemma model please'), ['Gemma 4 31B (Ollama cloud)'])
check('"the Nemotron one" is not a model number', labels('the Nemotron one'), nemotrons)
check('a bare number is not a name', labels('four'), [])
check('nothing like any of them is nothing', labels('qwen'), [])

/* ---------------------------------------------------- a place in a list */

check('"the second one"', P.placeIn('the second one', 5), 1)
check('"number one"', P.placeIn('number one', 5), 0)
check('"one"', P.placeIn('one', 5), 0)
check('"three"', P.placeIn('three', 5), 2)
check('"the last one"', P.placeIn('the last one', 5), 4)
check('past the end is nothing', P.placeIn('seven', 5), null)
check('a name is not a place', P.placeIn('Nemotron', 5), null)
check('"cancel" leaves it', P.isCancel('Cancel.'), true)
check('"never mind" leaves it', P.isCancel('never mind'), true)
check('a name is not a cancel', P.isCancel('Nemotron'), false)

/* ---------------------------------------------------- the five read out */

const order = (o) =>
  O.rankedModels(C.CLOUD_MODELS, {}, o)
    .filter((r) => r.rank)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.model.id)
const short = P.modelShortlist(order('balanced'), order('smarts'), order('speed'))
check('five of them', short.length, 5)
check('five different models', new Set(short.map((e) => e.id)).size, 5)
check('three balanced, then the smartest, then the fastest', short.map((e) => e.why), [
  'balanced',
  'balanced',
  'balanced',
  'smartest',
  'fastest'
])
check('the balanced three are the top three', short.slice(0, 3).map((e) => e.id), order('balanced').slice(0, 3))
const label = (id) => C.CLOUD_MODELS.find((m) => m.id === id).label
const speech = P.shortlistSpeech(short, label)
check('it says what each one is', /^Best overall: .+\. (The|Next) smartest: .+\. (The|Next) fastest: .+\.$/.test(speech), true)
/* "Slash model" took thirteen seconds to read five, the sizes most of it. */
check('the size and the provider are for the screen', P.sayModel('Gemma 4 31B (Ollama cloud)'), 'Gemma 4')
check('and so is VL', P.sayModel('Nemotron 3.5 Super VL 120B'), 'Nemotron 3.5 Super')
check('the version stays', P.sayModel('GLM 5.3 Flash'), 'GLM 5.3 Flash')
{
  const said = C.CLOUD_MODELS.map((m) => P.sayModel(m.label))
  check('no two models sound the same', new Set(said).size, said.length)
  check('and each said name picks its own model', C.CLOUD_MODELS.every((m) => {
    const hits = P.matchSpoken(P.sayModel(m.label), C.CLOUD_MODELS.map((x) => ({ id: x.id, names: [x.label] })))
    return hits.length === 1 && hits[0] === m.id
  }), true)
}
const overlap = P.modelShortlist(['a', 'b', 'c', 'd'], ['a', 'd'], ['e'])
check('the smartest already listed: the next one, marked so', overlap[3], { id: 'd', why: 'smartest', top: false })
check('a long history is cut, and says so', P.numberedSpeech(Array.from({ length: 15 }, (_, i) => `Chat ${i}`), 12).endsWith('And 3 older.'), true)
check('numbered the way it is said', P.numberedSpeech(['Fish pie', 'Taxes']), 'One, Fish pie. Two, Taxes.')

/* ----------------------------------------------------- asked in words */

const intent = (t) => I.matchIntent(t)
check('"delete this chat" asks first', intent('delete this chat'), { kind: 'delete', pick: false, confirm: true })
check('"delete an old chat" lists them', intent('delete an old chat'), { kind: 'delete', pick: true })
check('"delete this" is not about the chat', intent('delete this'), null)
check('"resume a chat"', intent('resume a chat'), { kind: 'resume' })
check('"go back to an old conversation"', intent('go back to an old conversation'), { kind: 'resume' })
check('"continue the conversation" is talking, not a list', intent('continue the conversation'), null)
check('"change the model"', intent('change the model'), { kind: 'model', name: '' })
check('"switch to the Nemotron model"', intent('switch to the Nemotron model'), { kind: 'model', name: 'Nemotron' })
check('"change the model to gemma"', intent('change the model to gemma'), { kind: 'model', name: 'gemma' })
check('"use the fastest model"', intent('use the fastest model'), { kind: 'model', name: 'fastest' })
check('"switch to Firefox" is a window, not a model', intent('switch to Firefox'), null)

/* ------------------------------------------- the model running commands */

const proposal = (body) => K.readAppProposal(body)
const del = proposal('# Delete this chat\n/delete')
check('a delete is read', [del.line, del.reason, del.refused], ['/delete', 'Delete this chat', null])
check('and always asks, even on accept-all', del.harmless, false)
check('switching model may go by itself on accept-all', proposal('/model gemma').harmless, true)
check('/key is never the model’s', proposal('/key nvidia nvapi-x').refused !== null, true)
check('nor /approve', proposal('/approve all').refused !== null, true)
check('nor /open, which has its own card', proposal('/open example.com').refused !== null, true)
check('a command that does not exist says so', /no \/frobnicate/.test(proposal('/frobnicate').refused), true)
check('no command, no card', proposal('# just a reason'), null)

/* ---------------------------------------------------------------- wiring */

const app = read('src/renderer/src/App.tsx')
const turn = read('src/renderer/src/hooks/useVoiceTurn.ts')
const ask = read('src/renderer/src/components/AskCard.tsx')
const md = read('src/renderer/src/components/Markdown.tsx')
const card = read('src/renderer/src/components/AppCard.tsx')
const music = read('src/main/music.ts')
const main = read('src/main/index.ts')
const dictation = read('src/renderer/src/hooks/useDictation.ts')
const prompt = read('src/shared/assistant.ts')

check('a wumpy-app block becomes a card', md.includes("readTagged(children, 'language-wumpy-app')"), true)
check('the card waits like every other proposal', card.includes('registerPending('), true)
check('and is asked about by what it does', card.includes('spoken:'), true)
check('an approved delete runs as confirmed', /kind === 'delete' \? \{ \.\.\.action, confirmed: true \}/.test(app), true)
check('the model is told about the block', prompt.includes('```wumpy-app'), true)
check('a question card can be answered out loud', ask.includes('registerChoice('), true)
check('a voice turn answers questions asked during it', /newestChoice\(mark, since\)/.test(turn), true)
check('a name that fits several reads those back', /of them\. \$\{numberedSpeech/.test(turn), true)
check('a yes-or-no is only answered by yes or no', /choice\.confirm[\s\S]{0,400}yesNo\(heard\.heard\)/.test(turn), true)
check('/model through the earbuds reads the list', /if \(handsFree\(\)\) askModelAloud\(null\)/.test(app), true)
check('/resume through the earbuds reads the chats', /handsFree\(\)\) \{\s+await askChatsAloud\('resume'\)/.test(app), true)
check('a delete asked for in words asks first', /action\.confirm \|\| handsFree\(\)/.test(app), true)
check('a typed /delete still does not', /!action\.confirmed && \(action\.confirm \|\| handsFree\(\)\)/.test(app), true)
check('the answer read is this turn’s, by time', /createdAt >= started/.test(turn), true)

/* ------------------------------------------- the rankings, said any way */

/* "Allow me to say the smartest one, or like smartest model, or like you
   know most intelligent model... the fastest model, quickest model, and
   also the best overall model, generally efficient model." */
for (const [said, want] of [
  ['the smartest one', 'smarts'], ['smartest model', 'smarts'], ['most intelligent model', 'smarts'],
  ['the cleverest', 'smarts'], ['the most capable one', 'smarts'], ['the brainiest', 'smarts'],
  ['the fastest model', 'speed'], ['quickest model', 'speed'], ['the speediest one', 'speed'], ['lowest latency', 'speed'],
  ['the best overall model', 'balanced'], ['generally efficient model', 'balanced'], ['the most efficient one', 'balanced'],
  ['best overall', 'balanced'], ['the recommended one', 'balanced'], ['fast and smart', 'balanced'],
  ['the best fast one', 'speed'], ['the best smart model', 'smarts']
]) {
  const got = P.orderingIn(said)
  check(`"${said}" is the top of ${want}`, got && !got.rest ? got.ordering : got, want)
}
check('"the fastest Nemotron" leaves the name', P.orderingIn('the fastest Nemotron'), { ordering: 'speed', rest: 'nemotron' })
check('a name is not a ranking', P.orderingIn('Nemotron Ultra'), null)
check('nor is "Lightning", which is a name', P.orderingIn('Nemotron Lightning'), null)
check('nor "Flash"', P.orderingIn('GLM Flash'), null)
check('each ranking answers to its word', P.ORDER_NAME, { balanced: 'best', smarts: 'smartest', speed: 'fastest' })
check('the list answers to those words', /balanced: \['best'/.test(app) && /smartest: \['smartest'/.test(app) && /fastest: \['fastest'/.test(app), true)
check('and the picker takes the top for any of them', /const top = all\.find\(\(o\) => o\.names\?\.includes\(ORDER_NAME\[ranked\.ordering\]\)\)/.test(turn), true)
check('/model "the most intelligent model" picks it', /readOrdering\(action\.name\.replace\(\/\\s\+one\$\/i, ''\)\) \?\? \(asked && !asked\.rest \? asked\.ordering : null\)/.test(app), true)

/* "Slash model" said while the list was read chose GLM 5.3 Flash: slash
   is one slip from flash. */
check('"slash model" names no model', labels('slash model'), [])
check('"Flash" still does', labels('the flash one').every((l) => /Flash/.test(l)) && labels('the flash one').length > 0, true)
check('a command said to the picker leaves it and runs', /if \(command\?\.sure\) \{[\s\S]{0,200}depsRef\.current\.send\(command\.command\)\s+return 'left'/.test(turn), true)
check('but "Flash model" there is a model', /spokenCommand\(said, commandNames\(\), false\)/.test(turn), true)
/* "Nematry Ultra": Whisper's Nemotron Ultra. The Ultra lands it. */
check('"Nematry Ultra" is Nemotron Ultra', labels('Nematry Ultra'), ['Nemotron 3 Ultra 550B'])

/* Mid-conversation, with no slash: "switch to the smartest model". */
const names = C.CLOUD_MODELS.map((m) => ({ id: m.id, names: [m.label] }))
for (const [said, want] of [
  ['Switch to the smartest model.', '/model the smartest one'],
  ['Can you change to the fastest one?', '/model the fastest one'],
  ['Use the most intelligent model', '/model the smartest one'],
  ['switch to Nemotron Ultra', '/model nemotron ultra'],
  ['Okay, can you switch over to Gemma?', '/model gemma'],
  ['change the model to step fun', '/model step fun'],
  ['switch to dark mode', null],
  ['go to the cloud', null],
  ['go to the fastest route', null],
  ['what is the smartest model?', null],
  ['switch to the best', '/model the best one']
]) check(`"${said}"`, P.modelSwitchIn(said, names), want)
check('and a turn sends it as the command', /spokenSlash\(heard\.heard\) \?\? modelSwitchIn\(heard\.heard, MODEL_NAMES\)/.test(turn), true)

check('music is held for a voice turn', /music\.hold\(\)[\s\S]*music\.release\(\)/.test(turn), true)
check('and while dictating', /music\.hold\(\)/.test(dictation) && /letMusicGo\(\)/.test(dictation), true)
check('main pauses only when the setting allows', /settings\.get\('pauseMusic'\) !== false/.test(main), true)
check('and lets go on quit', /releaseAllMusic\(\)/.test(main), true)
check('only what was playing is resumed', /=== 'Paused'\) await linuxSend\(name, 'Play'\)/.test(music), true)
check('the playerctld proxy is not paused twice', music.includes("!n.includes('playerctld')"), true)
check('Windows uses the session manager', music.includes('GlobalSystemMediaTransportControlsSessionManager'), true)

console.log(`\n${failures === 0 ? 'all' : `${failures} FAILED of the`} spoken picking checks${failures ? '' : ' correct'}`)
process.exit(failures ? 1 : 0)

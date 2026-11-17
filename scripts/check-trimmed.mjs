/**
 * Everything still works, with the trimming on.
 *
 * Today the preamble went from 13,341 tokens to 7,841 on a plain turn, by
 * leaving out whole sections and by carving three stretches out of the shell
 * rules. Each of those cuts was argued for one at a time. This is the pass
 * that asks the other question: across EVERY combination of what a turn can
 * need - all thirty-two of them - is what remains still a working prompt?
 *
 * Three properties, and each one is a way the carving could have gone wrong
 * without any single check noticing:
 *
 *   NOTHING LOAD-BEARING WENT. lean.ts carries a measured list of the rules
 *   that hold the benchmark up - the ones whose absence cost rungs when the
 *   prompt was last cut down on purpose. Every one of them must survive
 *   every combination, because none of them is about a capability and so
 *   none of them should ever be gated.
 *
 *   EVERY BLOCK IS STILL NAMED. The whole safety argument for stubbing is
 *   that the model is never left unaware: short of detail, never short of
 *   knowing the capability exists. That is only true if every fence the app
 *   can parse appears somewhere in every assembly, and it is the kind of
 *   claim that quietly stops being true.
 *
 *   NOTHING WAS CUT IN HALF. Paragraphs are removed from the middle of a
 *   section that contains fenced examples. Take out the wrong one and the
 *   prompt ends with an unclosed ``` - which does not fail anything, it just
 *   makes the rest of the instructions look like code to the model.
 *
 * Run with: npm run check:trimmed
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const files = [
  ['src/shared/assistant.ts', '.trimmed-prompt.mjs'],
  ['src/shared/needs.ts', '.trimmed-needs.mjs'],
  ['src/shared/lean.ts', '.trimmed-lean.mjs']
]
for (const [entryPoints, outfile] of files) {
  await build({
    entryPoints: [entryPoints],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    alias: { '@shared': 'src/shared' }
  })
}
const A = await import(pathToFileURL(files[0][1]).href)
const N = await import(pathToFileURL(files[1][1]).href)
const L = await import(pathToFileURL(files[2][1]).href)
for (const [, outfile] of files) rmSync(outfile, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const TOPICS = ['open', 'desktop', 'install', 'picture', 'write', 'remember']
const FULL = { scope: 'full', search: true, screen: true, browser: true, quota: true }

/** All sixty-four combinations of what a turn can need. */
const COMBINATIONS = []
for (let bits = 0; bits < 1 << TOPICS.length; bits++) {
  COMBINATIONS.push(TOPICS.filter((_, i) => bits & (1 << i)))
}
check('every combination is covered', COMBINATIONS.length, 64)

/* -------------------------------------------- nothing load-bearing went */

/*
 * The rules in LOAD_BEARING were identified by measurement: each one cost
 * benchmark rungs when it was removed. None is about a capability, so none
 * should ever be gated - and if a future gate catches one, this says which.
 */
{
  const missing = []
  for (const lean of [false, true]) {
    for (const combination of COMBINATIONS) {
      const text = A.assemblePrompt({ ...FULL, lean, needs: combination })
      for (const rule of L.LOAD_BEARING) {
        if (!text.includes(rule.heading)) {
          missing.push(`${rule.heading} @ [${combination.join(',')}]${lean ? ' lean' : ''}`)
        }
      }
    }
  }
  check('every measured rule survives every combination', missing.slice(0, 4), [])
  check('and there are thirteen of them', L.LOAD_BEARING.length, 13)
  /*
   * Both modes, because the short form is a different thirteen-rule carrier:
   * LEAN_PROMPT alone contains NONE of them and middlePrompt puts them back
   * from the live text, which is exactly the sort of arrangement that holds
   * until someone renames a heading.
   */
  check('including with the short instructions', missing.filter((m) => m.endsWith('lean')), [])
}

/* The guardrails whose absence is dangerous rather than merely worse. */
{
  const always = [
    'NEVER SAY IT IS DONE IN THE SAME BREATH',
    'A HUGE SCOPE IS A MISUNDERSTANDING',
    'CANNOT READ THEIR API KEYS',
    'THEIR FOLDERS ARE NOT WHERE YOU THINK',
    'NEVER FIND AND CHANGE IN THE SAME COMMAND',
    'CLOSING AN APP IS NOT KILLING ITS PROCESSES'
  ]
  const gone = []
  for (const combination of COMBINATIONS) {
    const text = A.assemblePrompt({ ...FULL, needs: combination })
    for (const rule of always) if (!text.includes(rule)) gone.push(`${rule} @ [${combination.join(',')}]`)
  }
  check('and so does every destructive-action guard', gone.slice(0, 4), [])
}

/* ------------------------------------------- every block is still named */

/*
 * Short of detail, never short of knowing the capability exists. A fence
 * that is not named anywhere is a capability the model cannot use at all.
 */
{
  const fences = ['wumpy-run', 'wumpy-write', 'wumpy-ask', 'wumpy-screen', 'wumpy-open', 'wumpy-do', 'wumpy-search']
  const unnamed = []
  for (const lean of [false, true]) {
    for (const combination of COMBINATIONS) {
      const text = A.assemblePrompt({ ...FULL, lean, needs: combination })
      for (const fence of fences) {
        if (!text.includes(fence)) unnamed.push(`${fence} @ [${combination.join(',')}]${lean ? ' lean' : ''}`)
      }
    }
  }
  check('every block the app parses is named', unnamed.slice(0, 4), [])
}

/* ------------------------------------------- what the short form costs */

{
  const plain = (lean) => A.preambleTokens({ ...FULL, lean, needs: [] })
  /* The lean form lifts whole sections out of the full one, so it moves
     when they do. The whole-drive file search added a line to A HUGE SCOPE
     IS A MISUNDERSTANDING, which is lifted, and removed two from the end of
     AND NEVER RETURN AN UNBOUNDED LIST, which is lifted too - so the short
     form got 9 tokens SHORTER while the full one grew by 70. */
  /* Both ends moved together when APP_PROMPT learned that Wumpy can hear
     the speakers: the short form rewrites the three always-sent sections
     and APP_PROMPT is not one of them, so it goes out whole either way.
     Which is the point of it being there - a sentence about a meeting is
     exactly the turn that sends nothing else. */
  /* 8,286 -> 8,542 and the saving 2,960 -> 3,216, both from the same 256
     tokens: ASK_PROMPT learning that "so do it" points at what was just
     said, and that a complaint is the request arriving again rather than a
     remark to agree with. The short form did not move at all, because it
     lifts named sections by heading and these two are not among them - so
     the gap widened without the short form losing anything it had. Worth
     stating rather than leaving as a number: the short form does NOT carry
     this fix, and would keep the behaviour it was written for. */
  /* +87 for the app's own commands, proposed in a wumpy-app block rather
     than only named. See check-needs for the reasoning. */
  /* +2 and +3 for /restart in the same list, which both forms send whole. */
  /* +11 and +14 for the <remember> tag: "nothing is saved without it"
     replaces "you cannot save anything" in both forms. See check-needs. */
  check('the full instructions, plain turn', plain(false), 8642)
  check('the short ones', plain(true), 5430)
  check('which is about 3,200 a turn', plain(false) - plain(true), 3212)
  /* It only replaces the three always-sent sections; the gated ones still
     come and go on the same rules. */
  const withScreen = (lean) => A.preambleTokens({ ...FULL, lean, needs: ['desktop'] })
  check('and the gating still applies on top', withScreen(true) > plain(true), true)
  /* A custom voice means the user replaced the prompt themselves: the short
     form is a rewrite of OUR words and must not silently replace theirs. */
  const custom = { ...FULL, lean: true, base: 'You are a pirate.', needs: [] }
  check('a custom voice is never swapped for the short one', A.assemblePrompt(custom).includes('You are a pirate.'), true)
}

/* ------------------------------------------------ nothing was cut in half */

/*
 * The shell rules contain fenced examples and paragraphs are removed from
 * between them. An unbalanced fence does not fail anything - it just turns
 * the rest of the instructions into a code block as far as the model is
 * concerned, which is the kind of damage nobody finds by reading.
 */
{
  const unbalanced = []
  for (const combination of COMBINATIONS) {
    const text = A.assemblePrompt({ ...FULL, needs: combination })
    const ticks = (text.match(/^```/gm) ?? []).length
    if (ticks % 2 !== 0) unbalanced.push(`[${combination.join(',')}] has ${ticks}`)
    /*
     * And no paragraph may begin mid-sentence, which is what a cut in the
     * wrong place leaves behind. Lower case only: the prompt opens headings
     * with "AND NEVER SAY IT IS DONE" and "AND AN INSTALL IS NOT FINISHED"
     * on purpose, and a case-insensitive test called every one of those a
     * severed paragraph - including in the untrimmed original, which is how
     * a check can be wrong while looking right.
     */
    if (/\n\n\s*(and|or|but|then|so|which|that is|it is)\b/.test(text)) {
      unbalanced.push(`[${combination.join(',')}] starts a paragraph mid-sentence`)
    }
  }
  check('fences are balanced in every combination', unbalanced.slice(0, 4), [])
}

/* ------------------------------------------------- and nothing was gained */

/*
 * The trimmed prompt must be a SUBSET: every combination has to be shorter
 * than the full one and longer than the empty one, and the full one has to
 * be the original string exactly. Anything else means the carving is
 * rewriting rather than removing.
 */
{
  const whole = A.assemblePrompt(FULL)
  check('with every topic it is the original', A.assemblePrompt({ ...FULL, needs: TOPICS }) === whole, true)
  check('and with none it is the shortest', A.preambleTokens({ ...FULL, needs: [] }), 8642)
  const sizes = COMBINATIONS.map((c) => A.preambleTokens({ ...FULL, needs: c }))
  check('nothing is longer than everything', Math.max(...sizes), A.preambleTokens(FULL))
  check('and nothing is shorter than nothing', Math.min(...sizes), 8642)
  /* Adding a topic may never shorten the prompt. */
  const notMonotonic = []
  for (const combination of COMBINATIONS) {
    for (const topic of TOPICS) {
      if (combination.includes(topic)) continue
      const more = A.preambleTokens({ ...FULL, needs: [...combination, topic] })
      const less = A.preambleTokens({ ...FULL, needs: combination })
      if (more < less) notMonotonic.push(`${topic} shortened [${combination.join(',')}]`)
    }
  }
  check('every topic only ever adds', notMonotonic.slice(0, 3), [])
}

/* --------------------------------- and the real turns land where they should */

/*
 * The shapes that actually occur, end to end through needsFor, so the
 * numbers in the commit messages are the numbers the app produces.
 */
{
  const turn = (content, images) => A.preambleTokens({ ...FULL, needs: N.needsFor([{ role: 'user', content, images }]) })
  check('a question about the app', turn('what is my key percentage'), 8642)
  check('an explanation', turn('why does this throw a TypeError'), 8642)
  check('a screenshot', turn('what is this', [1]) > 9000, true)
  check('a desktop request', turn('click the compose button') > 9000, true)
  check('and the whole thing is never sent by accident', turn('hello') < 13341, true)
}

console.log(`${NL}${count - failed}/${count} trimming checks passed`)
if (failed) process.exit(1)

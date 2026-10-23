/**
 * The three ways to rank the models, and the claims each one makes.
 *
 * Asked for in these words: "add different categories, for example the
 * smartness... one of them is on smartness, one is on speed, and one of
 * them is balanced. So balance is basically the recommended one."
 *
 * What is worth checking here is not that a sort function sorts. It is
 * that each tab answers its own question and no other - because the two
 * numbers behind them disagree sharply on this catalogue, and a tab that
 * quietly applied the other one's floor would look right while being the
 * same compromise under three names:
 *
 *   smartest  must be allowed to put a model that takes a hundred and
 *             twelve seconds first. That is the whole point of it, and it
 *             is also the thing a cautious edit would "fix".
 *   fastest   must be allowed to put a model that gets seventeen of
 *             forty-two rungs first, for the same reason.
 *   balanced  must do neither, and must agree with the recommendation
 *             printed by `/model check` - one judgement, not two.
 *
 * And one rule that outranks all three: a model that answered nothing when
 * last checked cannot lead any of them.
 *
 * Run with: npm run check:order
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function load(entry, name) {
  const out = join(process.cwd(), `.order-check-${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error'
  })
  const mod = await import(pathToFileURL(out).href)
  rmSync(out, { force: true })
  return mod
}
const O = await load('src/shared/order.ts', 'o')
const C = await load('src/shared/cloud.ts', 'c')
const P = await load('src/shared/probe.ts', 'p')

let failed = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  const shown = JSON.stringify(got)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${String(what).padEnd(52)} ${
      shown?.length > 46 ? `${shown.slice(0, 46)}…` : shown
    }`
  )
  if (!ok) console.log(`     expected ${JSON.stringify(want)}`)
}

/** The catalogue in one order, as ids, best first. */
const listed = (ordering, fresh = {}) =>
  O.rankedModels(C.CLOUD_MODELS, fresh, ordering)
    .filter((r) => r.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.model)

const share = (m) => m.measured.clean / m.measured.of
const ms = (m) => m.measured.medianMs

/* --------------------------------------------------- there are three of them */

check('three tabs', O.ORDERINGS.map((o) => o.id), ['balanced', 'smarts', 'speed'])
check('balanced is the default', O.DEFAULT_ORDERING, 'balanced')
/* "So balance is basically the recommended one" - said out loud on the
   tab rather than only being true of the sort order. */
check(
  'and the only one that says it is recommended',
  O.ORDERINGS.filter((o) => o.tag).map((o) => `${o.id}: ${o.tag}`),
  ['balanced: recommended']
)
check('every tab has a label, a caption and a summary', O.ORDERINGS.every((o) => o.label && o.note && o.summary), true)
check('a settings file can be wrong', [O.isOrdering('smarts'), O.isOrdering('smartness'), O.isOrdering(null)], [true, false, false])
/* The words `/model <word>` accepts. `/model fast` has to work, because
   that is what somebody types. */
check('the command takes the obvious words', [
  O.readOrdering('smarts'),
  O.readOrdering('smartest'),
  O.readOrdering('fast'),
  O.readOrdering('speed'),
  O.readOrdering('balanced'),
  O.readOrdering('recommended')
], ['smarts', 'smarts', 'speed', 'speed', 'balanced', 'balanced'])
/* And nothing else, because a model id reaches the same parser. A bare
   word that is not one of these is a name. */
check('and nothing else', [O.readOrdering('nemotron'), O.readOrdering('gemma4:31b-cloud'), O.readOrdering('')], [null, null, null])

/* ------------------------------------------- the smartest tab is really that */

/*
 * The case the whole feature was asked for. DeepSeek holds 39/41, the
 * highest in the catalogue, and takes 112 seconds a turn - so the one
 * order Wumpy used to have ranked it EIGHTH, and there was no way to ask
 * the question it answers best.
 */
{
  const smart = listed('smarts')
  const best = C.CLOUD_MODELS.reduce((a, b) => (share(a) >= share(b) ? a : b))
  check('the highest ladder score is first', smart[0].id, best.id)
  check('which is the one that takes two minutes', ms(smart[0]) > C.UNUSABLY_SLOW_MS, true)
  /* Monotonic in score, with no speed rule anywhere in it. */
  check(
    'and the whole list falls by score',
    smart.every((m, i) => i === 0 || share(smart[i - 1]) >= share(m)),
    true
  )
  /* Two models share 38/42. An unstable order would shuffle them between
     renders, so the tie is broken on something. */
  const tied = smart.filter((m) => share(m) === 38 / 42)
  check('a tie is broken by speed, not by luck', tied.length > 1 && ms(tied[0]) <= ms(tied[1]), true)
  /* The caption has to say where the number comes from: it is run by
     hand and the hourly ranker cannot touch it. A tab called "smartest"
     beside a clock that updates itself invites exactly that assumption. */
  const note = O.orderNote('smarts', C.CLOUD_MODELS)
  check('the caption says the ladder is run by hand', /by hand/.test(note), true)
  check('and that the hourly check never moves it', /hourly/.test(note), true)
  /* And what ignoring the clock cost today, by name, because a #1 badge
     on a two-minute model is a surprise worth spending a clause on. */
  check('and names the model it just put first', note.includes(smart[0].label), true)
  check('with how long it takes', /112s a turn/.test(note), true)
}

/* -------------------------------------------- the fastest tab is really that */

{
  const quick = listed('speed')
  const fastest = C.CLOUD_MODELS.filter((m) => m.measured).reduce((a, b) => (ms(a) <= ms(b) ? a : b))
  check('the quickest is first', quick[0].id, fastest.id)
  check('and the list rises by time', quick.every((m, i) => i === 0 || ms(quick[i - 1]) <= ms(m)), true)
  /*
   * A weak model is genuinely quick and this tab says so. 22/42 at 1.3s
   * is second here and sixth on balanced, which is the difference between
   * the two tabs stated as a fact rather than as a caption.
   */
  const weak = C.CLOUD_MODELS.find((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b')
  check('a model that fails half the ladder can be second on speed', quick[1].id, weak.id)
  check('and is sixth on balanced', listed('balanced').findIndex((m) => m.id === weak.id) + 1, 6)
  check('the caption warns that quick is not right', /not the same as/.test(O.orderNote('speed')), true)
  /* The picker prints a caption as TEXT, not as markdown - it is a
     <p> beside the tabs, not a message. A backticked command or a
     bolded model name would arrive with its punctuation showing. */
  check(
    'and no caption smuggles markdown into a plain <p>',
    O.ORDERINGS.map((o) => o.id).filter((id) => /[`*_]/.test(O.orderNote(id, C.CLOUD_MODELS))),
    []
  )
}

/* ------------------------------------------------------ balanced is the blend */

{
  const bal = listed('balanced')
  /* Nothing past the floor can lead, which is the 19 Oct rule and the
     only one of the three tabs it applies to. */
  check('the leader answers in time', ms(bal[0]) < C.UNUSABLY_SLOW_MS, true)
  check('and everything past the floor is at the bottom', bal.slice(-2).every((m) => ms(m) > C.UNUSABLY_SLOW_MS), true)
  /* Monotonic in the blended score within the group that answers. */
  const quick = bal.filter((m) => ms(m) < C.UNUSABLY_SLOW_MS)
  const points = (m) => O.balanceScore(share(m), ms(m))
  check(
    'and falls by the blend',
    quick.every((m, i) => i === 0 || points(quick[i - 1]) >= points(m)),
    true
  )
  /*
   * The two judgements the arithmetic exists to make, named.
   *
   * One rung is not worth two orders of magnitude: Ultra at 38/42 and a
   * second beats DeepSeek at 39/41 and 112 seconds. Sixteen rungs are not
   * worth a fifth of a second: the VL model at 38/42 and eleven seconds
   * beats Lightning at 22/42 and 1.3s.
   */
  check('one rung does not buy a hundred seconds', bal[0].id, 'nvidia/nemotron-3-ultra-550b-a55b')
  check(
    'and a fifth of a second does not buy sixteen rungs',
    bal.findIndex((m) => m.id === 'nvidia/nemotron-3.5-super-vl-120b-a12b') <
      bal.findIndex((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b'),
    true
  )
  check('the caption gives the rate', /three ladder rungs/.test(O.orderNote('balanced')), true)
  check('and the floor in seconds', /30s/.test(O.orderNote('balanced')), true)
}

/* ---------------------------------- one judgement, not two, on the same screen */

/**
 * THE REPORT AND THE LIST HAVE TO AGREE.
 *
 * `/model check` ends with a recommendation, scored on the ladder share
 * less a log penalty for slowness, and the picker's order was a different
 * rule: score first, speed as a tie-break. Both were defensible and they
 * disagreed on this catalogue - which is two readings of one machine
 * printed two inches apart, the failure mode this whole area of the code
 * keeps a diary of.
 *
 * So the formula has one home and the report imports it. Checked by
 * asserting the constants arrive through probe.ts unchanged and that the
 * two orderings of the same data match.
 */
check('the report uses the shared rate', [P.SLOWNESS_COST, O.SLOWNESS_COST], [0.08, 0.08])
check('and the same floor under free speed', [P.FAST_ENOUGH_MS, O.FAST_ENOUGH_MS], [2000, 2000])
/* Two names for 30 seconds, one value, by construction. */
check('and one usable-speed floor, not two', P.TOO_SLOW_TO_SUGGEST_MS, C.UNUSABLY_SLOW_MS)
{
  /* The report scores on the time it just measured, so give it the
     catalogue's times and the two orders have to come out the same. */
  const results = C.CLOUD_MODELS.filter((m) => m.measured).map((m) => ({
    model: m.id,
    provider: m.provider,
    state: 'ok',
    ms: ms(m),
    runs: 2
  }))
  const recommended = P.recommend(results).map((p) => p.model)
  const balanced = listed('balanced')
    .filter((m) => ms(m) < C.UNUSABLY_SLOW_MS)
    .map((m) => m.id)
  check('the list and the recommendation rank alike', balanced, recommended)
}

/* ------------------------------------------- a dead model leads nothing at all */

/**
 * Slow is not dead, and the difference matters on every tab.
 *
 * A model past the floor is still sorted on: it answers, somebody may
 * want it, and the smartest tab is allowed to put it first. A model that
 * answered NOTHING when last checked is a row that cannot be chosen
 * usefully, so it goes under everything on all three - including the tab
 * where it holds the highest score in the catalogue.
 */
{
  const best = C.CLOUD_MODELS.reduce((a, b) => (share(a) >= share(b) ? a : b))
  const dead = { [best.id]: { ms: 0, runs: 2, on: '2026-10-23', ok: false } }
  for (const ordering of ['balanced', 'smarts', 'speed']) {
    const list = listed(ordering, dead)
    check(`on ${ordering}, a model that answered nothing is last`, list[list.length - 1].id, best.id)
    check(`and is still listed on ${ordering}`, list.some((m) => m.id === best.id), true)
  }
  /*
   * AND IT IS LAST BECAUSE IT FAILED, not because it was slow.
   *
   * A failure is recorded with the time it took to fail, which for an
   * empty answer or a refused key is zero - and zero milliseconds is
   * infinitely fast. This check found the balanced tab handing the
   * best blended score in the catalogue to a model that had just
   * answered nothing, kept at the bottom only by the group above it
   * happening to exist. The tiering is three steps now: works, slow,
   * silent.
   */
  check(
    'a failure is below even the models that take two minutes',
    listed('balanced', dead)
      .slice(-3)
      .map((m) => m.id.split('/').pop()),
    /* The weakest model that works, then the one that takes two minutes,
       then the one that said nothing. */
    ['nemotron-3-nano-omni-30b-a3b-reasoning', 'glm-5.3', 'deepseek-v4.1-flash']
  )
  /* Its caption stops naming it, because it is no longer what the tab
     just did. */
  check(
    'the smartest caption drops a dead leader',
    O.orderNote('smarts', C.CLOUD_MODELS, dead).includes(best.label),
    false
  )
}

/* A fresh time replaces the catalogue's on every tab, which is the 22 Oct
   lesson: both readings are of the same quantity and one is from today. */
{
  const deep = 'deepseek-ai/deepseek-v4.1-flash'
  const fresh = { [deep]: { ms: 6_213, runs: 2, on: '2026-10-22', ok: true } }
  check('measured at six seconds it leads the balanced tab', listed('balanced', fresh)[0].id, deep)
  check('and the smartest tab, where it always did', listed('smarts', fresh)[0].id, deep)
  /* The ladder is untouched by any probe: there is no path from a
     latency to a capability score, which is what stops a quick model
     being promoted into looking clever. */
  check(
    'but no measurement can move a ladder score',
    O.shareOf(C.CLOUD_MODELS.find((m) => m.id === deep)),
    39 / 41
  )
}

/* ------------------------------------------------- it is wired into the panel */

const renderer = readFileSync('src/renderer/src/App.tsx', 'utf8')
const picker = readFileSync('src/renderer/src/components/Picker.tsx', 'utf8')
const report = readFileSync('src/renderer/src/settingsreport.ts', 'utf8')

check('the picker is given the tabs', /tabs: \{/.test(renderer), true)
check('with the caption for the one showing', /note: orderNote\(ordering, CLOUD_MODELS, latencies\)/.test(renderer), true)
check('and the choice is remembered', /patch\(\{ modelOrder: id \}\)/.test(renderer), true)
/* Tab moves between them, and must not reach the window handler that
   cycles approval mode - which would change the permission model because
   somebody was reading the list backwards. */
check('Tab switches tabs', /e\.key === 'Tab' && tabs/.test(picker), true)
check('and is stopped before the approval cycle sees it', /e\.stopPropagation\(\)/.test(picker), true)
/* `/settings` carries it, because a #1 badge means a different thing on
   each tab and the sheet is where somebody checks what they are looking
   at. */
check('/settings says which order the list is in', /model list ranked by/.test(report), true)

console.log(failed === 0 ? '\nall order checks correct' : `\n${failed} order checks FAILED`)
process.exit(failed === 0 ? 0 : 1)

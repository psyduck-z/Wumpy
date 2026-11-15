/**
 * What a proposal would touch, said in a shape and a colour.
 *
 * Every card used to be the same object on screen - a violet-topped box with
 * a word in it - whether it was about to run a shell line, replace a file,
 * send a picture of your desktop to a hosted model, or open a page. The one
 * thing most worth knowing before pressing Run was the thing the card said
 * most quietly, in the smallest type on it.
 *
 * Four families now, each with a primitive shape and a hue. What is checked
 * here is that the system cannot drift: that every card is in a family, that
 * the stylesheet draws every family, that no two families look alike, that
 * the shape alone tells them apart with the colour ignored, and that the
 * labels are actually readable on the surface they sit on.
 *
 * Run with: node scripts/check-kinds.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'

const out = join(process.cwd(), '.kinds-check.mjs')
await build({
  entryPoints: ['src/renderer/src/kinds.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const K = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(54)} ${JSON.stringify(actual)}`)
  if (!ok) console.log(`     expected ${JSON.stringify(expected)}`)
}

const read = (f) => readFileSync(f, 'utf8')
const styles = read('src/renderer/src/styles.css')

/* ------------------------------------------------- every card is in a family */

/**
 * The eight cards that ask permission for something, and the component that
 * draws each one. The question card is deliberately absent: it asks
 * something, it does not touch anything, so it has nothing to mark.
 */
const CARDS = {
  run: 'CommandCard',
  write: 'WriteCard',
  desktop: 'DoCard',
  screen: 'ScreenCard',
  look: 'LookCard',
  search: 'SearchCard',
  link: 'LinkCard',
  app: 'AppCard'
}

check('every card kind has a family', Object.keys(K.KIND_FAMILY).sort(), Object.keys(CARDS).sort())

const families = [...new Set(Object.values(K.KIND_FAMILY))].sort()
check('four families, no more', families, ['changes', 'out', 'runs', 'sees'])
check('each has a sentence about it', families.filter((f) => !K.FAMILY_WORD[f]), [])
check('and a shape', families.filter((f) => !K.FAMILY_SHAPE[f]), [])

// The shape is what makes the colour safe to use: it carries the same fact on
// its own, so nothing here depends on telling amber from teal. That only
// holds while no two families share one.
check('no two families share a shape', new Set(Object.values(K.FAMILY_SHAPE)).size, 4)
// Said as what happens if you press the button, not as the name of a bucket.
check(
  'the hover text is a sentence, not a label',
  families.filter((f) => K.FAMILY_WORD[f].split(' ').length < 3),
  []
)

/* --------------------------------------------- every card actually marks itself */

for (const [kind, component] of Object.entries(CARDS)) {
  const src = read(`src/renderer/src/components/${component}.tsx`)
  check(`${component} draws its mark`, src.includes(`<KindMark kind="${kind}" />`), true)
  // The attribute is what the stylesheet reads, and it comes from the shared
  // table rather than a string typed into the card - a literal here would be
  // a family nothing checks.
  check(`${component} carries its family`, src.includes(`data-family={KIND_FAMILY.${kind}}`), true)
  check(`${component} marks itself once`, src.split('<KindMark').length - 1, 1)
}

/* ------------------------------------------------- the stylesheet draws them all */

// `runs` is the accent, which is the default on .cmd rather than an attribute
// rule - it is what every card looked like before there were families.
check('the default family is the accent', /\.cmd \{\n\s*--kind: var\(--accent\)/.test(styles), true)
for (const family of families.filter((f) => f !== 'runs')) {
  check(
    `${family} sets its own colour`,
    new RegExp(`\\.cmd\\[data-family="${family}"\\] \\{\\n\\s*--kind:`).test(styles),
    true
  )
}
// Three of the four shapes are a rule; the square is the element itself.
check('the circle is drawn', /\[data-family="sees"\] \.cmd-mark \{\n\s*border-radius: 50%/.test(styles), true)
check('the triangle is drawn', /\[data-family="changes"\] \.cmd-mark[\s\S]{0,80}clip-path/.test(styles), true)
check('the diamond is drawn', /\[data-family="out"\] \.cmd-mark[\s\S]{0,320}rotate\(45deg\)/.test(styles), true)
check('the square needs nothing drawn', /\.cmd-mark \{[\s\S]{0,120}width: 8px/.test(styles), true)

// Everything coloured on a card reads --kind, so the border, the head, the
// label and the shape cannot come to disagree about what is at stake.
check('the border follows the family', /border: 1px solid rgb\(var\(--kind\) \/ 0\.35\)/.test(styles), true)
check('the head follows it', /\.cmd-head \{[\s\S]{0,200}rgb\(var\(--kind\) \/ 0\.16\)/.test(styles), true)
check('the label follows it', /\.cmd-shell \{[\s\S]{0,160}color: rgb\(var\(--kind-text\)\)/.test(styles), true)
check('the mark is filled with it', /\.cmd-mark \{[\s\S]{0,160}background: rgb\(var\(--kind\)\)/.test(styles), true)
// A focused card lights its own border, in its own colour: a violet edge was
// a visible change on a violet card and nearly none on a teal one.
check('a focused card lights its family', /\.cmd:focus-within \{\n\s*border-color: rgb\(var\(--kind\)/.test(styles), true)

/**
 * Danger outranks the family.
 *
 * What a destructive command touches matters less than the fact that it is
 * destructive, and red already means that everywhere else in the app. It
 * overrides the colour and not the shape, so the card still says which kind
 * of thing just went red.
 */
check(
  'a risky card goes red whatever its family',
  /\.cmd\.is-risky \{\n\s*--kind: var\(--danger\)/.test(styles),
  true
)
check(
  'and the run button never changes colour',
  /\.cmd-run \{\n\s*background: rgb\(var\(--accent\)\)/.test(styles),
  true
)

/* --------------------------------------------------- the colours themselves */

/** A `--name: r g b;` token from the stylesheet. */
function token(name) {
  const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`).exec(styles)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const FILL = { runs: token('accent'), changes: token('kind-change'), sees: token('kind-sees'), out: token('kind-out') }
const LABEL = {
  runs: token('accent-text'),
  changes: token('kind-change-text'),
  sees: token('kind-sees-text'),
  out: token('kind-out-text')
}
check('every family has a fill colour', Object.keys(FILL).filter((f) => !FILL[f]), [])
check('and a lighter one for the label', Object.keys(LABEL).filter((f) => !LABEL[f]), [])

/** WCAG relative luminance. */
function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The label is 10.5px uppercase on the card's surface, which is the smallest
 * type on the card and the one that names what it is. 4.5:1 is the WCAG
 * figure for text this size, and it is why the labels are a lighter pair than
 * the fills: the fills read fine as an 8px block of colour and three of them
 * do not read as type.
 */
const surface = token('surface')
for (const family of families) {
  const ratio = contrast(LABEL[family], surface)
  check(`the ${family} label is readable`, ratio >= 4.5, true)
  if (ratio < 4.5) console.log(`     ${ratio.toFixed(2)}:1 against the card surface`)
}

/**
 * And no two things that mean something look alike.
 *
 * Not a perceptual metric - just the distance between the two colours in
 * RGB, which is enough to catch the failure that matters: two meanings drawn
 * in hues that read as the same colour at 8px, where the shape would be
 * doing all the work on its own.
 *
 * This is not hypothetical. `sees` was first written as a blue 57 points
 * from the violet accent, and on a near-black panel an 8px violet square
 * and an 8px blue circle are one colour and two shapes. The danger red is
 * in the matrix for the same reason, pointed at amber: "changes something"
 * and "this is destructive" are the two a user most needs to tell apart,
 * and they are next to each other on the colour wheel.
 */
function apart(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
const MEANS = { ...FILL, danger: token('danger') }
const names = Object.keys(MEANS)
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const [a, b] = [names[i], names[j]]
    const d = apart(MEANS[a], MEANS[b])
    check(`${a} and ${b} are different colours`, d >= 60, true)
    if (d < 60) console.log(`     ${d.toFixed(0)} apart in RGB`)
  }
}

/* ------------------------------- the stylesheet still says what it reads as */

/**
 * A comment does not end a selector.
 *
 * Found by accident next to the picker: a block comment had been pasted
 * between `.picker-row.is-removing` and its `{`, which reads as
 * `.picker-row.is-removing .picker-badge` - one selector, two rules quietly
 * gone. The ✕ stopped appearing on every row in remove mode, and the
 * capability badge was styled only inside a row being removed, which is to
 * say never.
 *
 * Nothing complains about this. CSS has no syntax error to raise here: both
 * halves are valid, the file parses, and the only symptom is a rule that
 * does nothing. So it is checked.
 */
{
  let inside = 0
  for (let at = styles.indexOf('/*'); at !== -1; at = styles.indexOf('/*', at + 2)) {
    const end = styles.indexOf('*/', at + 2)
    if (end === -1) break
    const before = styles.slice(0, at).trimEnd()
    const after = styles.slice(end + 2)
    const stop = after.search(/[{};]/)
    /* The comment is followed by a selector (the next punctuation is its
       opening brace) but is NOT preceded by the end of something - so it is
       sitting in the middle of a selector. */
    /* `*／` counts as the end of something too: two comments in a row above
       one rule is the house style, not a broken selector. */
    if (stop >= 0 && after[stop] === '{' && before && !/([};{,]|\*\/)$/.test(before)) {
      inside++
      console.log(`     after: ${before.slice(-60)}`)
    }
  }
  check('no comment sits inside a selector', inside, 0)
}
check('the ✕ shows on every row in remove mode', /\.picker-row\.is-removing \.picker-del \{/.test(styles), true)
check('and the badge is styled outside one', /\n\.picker-badge \{/.test(styles), true)

/* ------------------------------------------------- and they can be looked up */

/**
 * A shape nobody can look up is a shape to be guessed at.
 *
 * /help is the only place the system is explained, and the rows are built
 * from kinds.ts rather than typed into the table - an explanation that can
 * drift from what is drawn on screen is worse than no explanation.
 */
const cmdOut = join(process.cwd(), '.kinds-cmds.mjs')
await build({
  entryPoints: ['src/renderer/src/commands.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: cmdOut,
  logLevel: 'error'
})
const cmds = await import(pathToFileURL(cmdOut).href)
const help = cmds.helpText()
rmSync(cmdOut, { force: true })

check('the marks are explained somewhere', help.includes('What a card would touch'), true)
for (const family of K.FAMILIES) {
  const glyph = K.SHAPE_GLYPH[K.FAMILY_SHAPE[family]]
  check(`${family} is in the table`, help.includes(`| ${glyph} | ${K.FAMILY_WORD[family]} |`), true)
}
check('four rows and no more', help.split('\n').filter((l) => /^\| [■▲●◆] \|/.test(l)).length, 4)
// Red is the exception to the whole scheme, so the one place it is explained
// has to say so.
check('and that red overrides it', /Red overrides the colour/.test(help), true)
// The marks are explained in /shortcuts too, which is the command somebody
// reaches for when they cannot remember a symbol either.
check('the sheet explains them as well', cmds.shortcutsText().includes('| ■ |'), true)

console.log(failures ? `\n${failures} kind checks FAILED` : '\nall kind checks')
process.exitCode = failures ? 1 : 0

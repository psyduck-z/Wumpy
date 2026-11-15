/**
 * What a proposal would touch, in a shape and a colour.
 *
 * Every card Wumpy puts in front of you is the same object on screen: a
 * violet-topped box with a word in it. "New file", "Your screen", "Web
 * search" and a shell command were distinguishable only by reading them, and
 * they are not the same kind of thing at all - one writes to disk, one sends
 * a picture of whatever you had open, one drives your pointer. The thing you
 * most need to know before pressing Run is the one thing the card said
 * quietly, in words, in the smallest type on it.
 *
 * So the seven kinds collapse into four families, by what is actually at
 * stake, and each family gets a primitive shape and a colour. Four basic
 * shapes rather than seven pictograms on purpose: a square, a triangle, a
 * circle and a diamond are told apart at 8px and at a glance, which an icon
 * of a monitor and an icon of a window are not. The shape is also why the
 * colour is safe - it carries the same fact on its own, so nothing here
 * depends on telling amber from teal.
 *
 * The question card is deliberately not in this list. It asks something; it
 * does not touch anything, so it has nothing to mark.
 */

/** The eight cards that ask for something. */
export type CardKind = 'run' | 'write' | 'desktop' | 'screen' | 'look' | 'search' | 'link' | 'app'

/** What is at stake, which is what the shape and the colour say. */
export type Family = 'runs' | 'changes' | 'sees' | 'out'

/**
 * In order, least to most of a reach outwards: code here, a change here,
 * something of yours going out, the web. Used by /help, so the list anyone
 * reads is in a deliberate order rather than whatever order an object
 * happened to be written in.
 */
export const FAMILIES: readonly Family[] = ['runs', 'changes', 'sees', 'out']

/**
 * Which family each card belongs to.
 *
 * `run` is its own family rather than part of `changes` because executing
 * code is the open-ended one: a shell line can do anything the user can, so
 * what is at stake is not "a file" but "the machine". The two under
 * `changes` are bounded and nameable - this path, this click.
 */
export const KIND_FAMILY: Record<CardKind, Family> = {
  run: 'runs',
  write: 'changes',
  desktop: 'changes',
  screen: 'sees',
  look: 'sees',
  search: 'out',
  link: 'out',
  /* One of Wumpy's own commands, proposed by the model: it changes Wumpy -
     a chat deleted, a model switched - which is still a change. */
  app: 'changes'
}

/**
 * What the mark means, in the hover.
 *
 * Phrased as what happens if you press the button, not as a category name:
 * "Changes something on this machine" is a sentence about the consequence,
 * and "changes" on its own is a word about the taxonomy.
 */
export const FAMILY_WORD: Record<Family, string> = {
  runs: 'Runs code on this machine',
  changes: 'Changes something on this machine',
  sees: 'Sends something of yours to the model',
  out: 'Reaches the web'
}

/**
 * The shape drawn for each family, named so the stylesheet and this file can
 * be checked against each other.
 *
 * Only the names live here - the drawing is four CSS rules, because a square,
 * a circle, a triangle and a diamond are a border-radius, a clip-path and a
 * rotation rather than four SVGs.
 */
export const FAMILY_SHAPE: Record<Family, 'square' | 'triangle' | 'circle' | 'diamond'> = {
  runs: 'square',
  changes: 'triangle',
  sees: 'circle',
  out: 'diamond'
}

/**
 * The same four shapes as characters, for /help.
 *
 * A shape nobody can look up is a shape that has to be guessed at, and the
 * place this app explains itself is a markdown table - which can hold a
 * square but not a stylesheet. These are the geometric-shapes block, which
 * every Windows font has had for twenty years.
 */
export const SHAPE_GLYPH: Record<(typeof FAMILY_SHAPE)[Family], string> = {
  square: '■',
  triangle: '▲',
  circle: '●',
  diamond: '◆'
}

/** The hover text for a card's mark. */
export function markTitle(kind: CardKind): string {
  return FAMILY_WORD[KIND_FAMILY[kind]]
}

/** One row per family, for the table in /help. */
export function markLines(): Array<{ glyph: string; what: string }> {
  return FAMILIES.map((family) => ({
    glyph: SHAPE_GLYPH[FAMILY_SHAPE[family]],
    what: FAMILY_WORD[family]
  }))
}

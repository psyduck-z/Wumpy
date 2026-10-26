import { markTitle, type CardKind } from '../kinds'

/**
 * The shape at the left of a proposal's head.
 *
 * Deliberately empty: the shape and the colour are drawn from the family on
 * the card around it, so the border, the head tint, the label and this all
 * read one attribute and cannot come to disagree with each other. See
 * kinds.ts for which shape means what.
 *
 * Hidden from assistive technology on purpose - the word beside it already
 * says what the card is, and a screen reader does not need to be told the
 * shape of the dot in front of it. The title is for the mouse, which has
 * nothing else to hover.
 */
export function KindMark({ kind }: { kind: CardKind }): React.JSX.Element {
  return <span className="cmd-mark" title={markTitle(kind)} aria-hidden="true" />
}

import { useEffect, useId, useRef, useState } from 'react'
import { arrowNavigate } from '../keyboard'
import { registerChoice } from '../aloud'
import type { AskGroup } from './Markdown'

/**
 * Questions the model has put back to the user, with the options as buttons.
 *
 * Letting the model ask when a request is genuinely ambiguous — and letting
 * the answer be one click rather than a typed sentence — is cheaper than both
 * the guess and the correction.
 *
 * Two things changed after the user drove it.
 *
 * It takes several questions now. One was a limit from the local-model days,
 * when a 3.8B asking two things at once usually meant one; on a capable model
 * it just made the conversation longer, since "not installed, want the
 * website?" and "shall I check for an update too?" are two clicks' worth of
 * decision and three turns' worth of round trips.
 *
 * And it works from the keyboard. Wumpy opens on a hotkey and every other
 * card can be driven without the mouse; this one could not, which made a
 * question the one place the keyboard ran out.
 */
export function AskCard({
  groups,
  answered,
  onAnswer,
  aloud,
  askedAt
}: {
  groups: AskGroup[]
  /** The answer already given, if this block has been answered. */
  answered: string | null
  onAnswer(option: string): void
  /**
   * How a voice turn reads this one out, when Wumpy asked it: the list in
   * its own words, how many of the options that list numbers, what else
   * each option answers to, and whether it is a yes-or-no.
   */
  aloud?: {
    say?: string
    spoken?: number
    aliases?: string[][]
    unavailable?: Array<{ names: string[]; why: string }>
    ranked?: Partial<Record<'balanced' | 'smarts' | 'speed', string[]>>
    confirm?: boolean
  }
  /** When the question was asked: see AloudChoice.askedAt. */
  askedAt?: number
}): React.JSX.Element {
  const multi = groups.length > 1
  const [picked, setPicked] = useState<Record<number, string>>({})
  const [shown, setShown] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const done = answered !== null

  /*
   * Answerable out loud while it waits. One question only: a form of
   * several is filled in on screen, and asking four questions in a row into
   * somebody's ear is a survey, not a turn.
   */
  const key = useId()
  const answerRef = useRef(onAnswer)
  answerRef.current = onAnswer
  const single = groups.length === 1 ? groups[0] : null
  /* Parsed afresh on every render, so the effect keys on the words. */
  const question = single?.question ?? ''
  const optionKey = single ? single.options.join(String.fromCharCode(1)) : ''
  useEffect(() => {
    if (done || !single) return
    const options = single.options
    return registerChoice(key, {
      question,
      intro: aloud?.say,
      options: options.map((label, i) => ({ id: label, label, names: aloud?.aliases?.[i] })),
      numbered: aloud?.say ? options.slice(0, aloud.spoken ?? options.length) : undefined,
      unavailable: aloud?.unavailable,
      ranked: aloud?.ranked,
      confirm: aloud?.confirm,
      askedAt,
      choose: (id) => answerRef.current(id)
    })
  }, [done, question, optionKey, key, aloud?.say, aloud?.spoken, aloud?.aliases, aloud?.unavailable, aloud?.ranked, aloud?.confirm, askedAt])

  /**
   * The first option takes focus, so arrows work without a click first.
   *
   * Only once, and never when the block has already been answered: a
   * reopened chat full of answered questions must not fight for the caret.
   */
  const grabbed = useRef(false)
  useEffect(() => {
    if (done || grabbed.current) return
    grabbed.current = true
    const first = cardRef.current?.querySelector<HTMLButtonElement>('.ask-option')
    first?.focus({ preventScroll: true })
  }, [done])

  /** One question: picking is answering. Several: picking fills the form. */
  const choose = (index: number, option: string): void => {
    if (done) return
    if (!multi) {
      onAnswer(option)
      return
    }
    setPicked((p) => ({ ...p, [index]: option }))
  }

  const ready = multi && groups.every((_, i) => picked[i])

  /**
   * Answers go back as one line per question, so the model reads them as a
   * set rather than having to pair them up by position.
   */
  const submit = (): void => {
    if (!ready || done) return
    onAnswer(groups.map((g, i) => `${g.question} ${picked[i]}`).join(String.fromCharCode(10)))
  }

  /*
   * ANSWERED, SO OUT OF THE WAY. Asked for in those words: "make this
   * feedback decision hidden".
   *
   * A question that has been answered is being said twice. The card keeps
   * the question and all of its options on screen with one of them
   * highlighted, and directly underneath it is the user's own message saying
   * the same thing - which is the note-repeated-in-the-chat complaint again,
   * in a different card.
   *
   * Folded rather than removed. The answer is in the transcript either way,
   * but the question is not, and a scrollback of bare answers to questions
   * nobody can read is worse than a line of grey text. Clicking it puts the
   * card back, so nothing is actually lost - and it never folds before it
   * has been answered.
   */
  if (done && !shown) {
    return (
      <button type="button" className="ask is-answered is-folded" onClick={() => setShown(true)}>
        {multi ? `${groups.length} questions answered` : groups[0].question}
      </button>
    )
  }

  return (
    <div
      ref={cardRef}
      className={`ask ${done ? 'is-answered' : ''}`}
      onKeyDown={(e) => {
        // Enter submits a filled-in form from anywhere in the card, so the
        // last pick and the send are not two separate journeys.
        if (e.key === 'Enter' && ready) {
          e.preventDefault()
          submit()
          return
        }
        if (arrowNavigate(e, cardRef.current)) e.preventDefault()
      }}
    >
      {groups.map((group, i) => (
        <div className="ask-group" key={group.question + i}>
          <p className="ask-question">{group.question}</p>
          <div className="ask-options">
            {group.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`ask-option ${
                  (multi ? picked[i] === option : answered === option) ? 'is-chosen' : ''
                }`}
                disabled={done}
                onClick={() => choose(i, option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}

      {multi && !done && (
        <div className="ask-submit-row">
          <button type="button" className="ask-submit" disabled={!ready} onClick={submit}>
            {ready ? 'Send answers  ⏎' : `Pick ${groups.length - Object.keys(picked).length} more`}
          </button>
        </div>
      )}

      {!done && <p className="ask-hint">arrow keys to move, Enter to choose, or type your own</p>}
    </div>
  )
}

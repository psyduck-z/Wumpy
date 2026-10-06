/**
 * A question the model has put back to the user, with its options as buttons.
 *
 * Small local models guess when a request is ambiguous, and a wrong guess costs
 * a whole slow turn to discover. Letting the model ask instead — and letting
 * the answer be one click rather than a typed sentence — is cheaper than both
 * the guess and the correction.
 */
export function AskCard({
  question,
  options,
  answered,
  onAnswer
}: {
  question: string
  options: string[]
  /** The option already chosen, if this question has been answered. */
  answered: string | null
  onAnswer(option: string): void
}): React.JSX.Element {
  return (
    <div className={`ask ${answered ? 'is-answered' : ''}`}>
      <p className="ask-question">{question}</p>
      <div className="ask-options">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`ask-option ${answered === option ? 'is-chosen' : ''}`}
            disabled={answered !== null}
            onClick={() => onAnswer(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {answered === null && <p className="ask-hint">or just type your own answer</p>}
    </div>
  )
}

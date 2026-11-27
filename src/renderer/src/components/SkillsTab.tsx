import { shortly, type SkillSummary } from '@shared/skills'
import { skillSaidAs } from '@shared/spoken'

/**
 * Every skill, to click instead of remember: a click puts `/name ` in the
 * box on the Chat tab, ready for what it should work on.
 */
export function SkillsTab({
  skills,
  onRun,
  onNew,
  onFolder
}: {
  skills: SkillSummary[]
  onRun(name: string): void
  onNew(): void
  onFolder(): void
}): React.JSX.Element {
  const runnable = skills.filter((s) => s.command)
  const yours = runnable.filter((s) => !s.builtin)
  const shipped = runnable.filter((s) => s.builtin)
  const list = (items: SkillSummary[]): React.JSX.Element => (
    <ul className="skill-list">
      {items.map((s) => (
        <li key={s.name}>
          <button type="button" className="skill-row" onClick={() => onRun(s.name)} title={`Use /${s.name}`}>
            <span className="skill-name">/{s.name}</span>
            <span className="skill-what">{shortly(s.description)}</span>
            <span className="skill-say">say “use {skillSaidAs(s)} on …”</span>
          </button>
        </li>
      ))}
    </ul>
  )
  return (
    <div className="tab-page" role="tabpanel">
      <div className="tab-actions">
        <button type="button" className="btn btn-accent" onClick={onNew}>
          New skill
        </button>
        <button type="button" className="btn" onClick={onFolder}>
          Open folder
        </button>
      </div>
      {yours.length > 0 && (
        <section className="set-section">
          <h2>Yours</h2>
          {list(yours)}
        </section>
      )}
      <section className="set-section">
        <h2>{yours.length ? 'Built in' : 'Skills'}</h2>
        {shipped.length ? list(shipped) : <p className="set-sub">None yet.</p>}
      </section>
    </div>
  )
}

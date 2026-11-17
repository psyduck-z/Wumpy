import { savesIn } from '@shared/kept'

/**
 * Saves what a finished answer asked to be kept - a line for their notes, a
 * skill made, changed or removed (see @shared/kept) - and says each one in
 * the transcript, so nothing is kept behind their back and a wrong one can
 * be undone: `/remember clear`, or the file in the skills folder.
 */
export async function keepSaves(text: string, note: (content: string, error?: boolean) => void): Promise<void> {
  if (!text.includes('<')) return
  const { remember, skills } = savesIn(text)
  for (const fact of remember) {
    const r = await window.wumpy.context.set(fact, true).catch(() => null)
    if (!r?.ok) {
      note(`Couldn't save that to your notes${r?.why ? `: ${r.why}` : '.'}`, true)
      continue
    }
    note(
      `Saved to your notes: “${fact}”` +
        (r.truncated ? ' — they are now longer than what each chat is sent, so the end is cut off. `/remember clear` empties them.' : '')
    )
  }
  for (const skill of skills) {
    const r = await window.wumpy.skills.save(skill).catch(() => null)
    if (!r?.ok) {
      note(`Couldn't save the skill “${skill.name}”${r?.why ? `: ${r.why}` : '.'}`, true)
      continue
    }
    note(
      r.did === 'removed'
        ? `Removed the skill “${r.name}”.`
        : `${r.did === 'replaced' ? 'Updated' : 'Saved'} the skill “${r.name}” — it is used whenever it comes up.`
    )
  }
}

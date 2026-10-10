/**
 * Fence tags, and the models that will not write ours.
 *
 * Shared rather than living in the renderer, because bench-ceiling has to
 * apply the same transform. A benchmark that reads the model's raw output
 * while the app reads a normalised version is measuring a Wumpy that does
 * not exist - and that is exactly what happened: Gemini scored 1 of 38
 * against a harness that had never heard of the fix.
 */

/**
 * Promotes a plain shell fence to a runnable one, for models that will not
 * write Wumpy's tag.
 *
 * Gemini answers "how much free space is on my C drive" with a correct
 * Get-PSDrive command inside ```powershell. Wumpy asks for ```wumpy-run,
 * and without that tag the command is just grey text - so a model clever
 * enough for the whole ladder scored 1 of 38, almost all of it this.
 *
 * Narrow on purpose, because the alternative is a Run button under every
 * snippet anyone ever writes to illustrate syntax:
 *
 *   - only for models flagged looseFences in the registry
 *   - only when the reply contains NO wumpy-run block already, so a model
 *     that tagged one correctly and then showed an example keeps the
 *     distinction it drew
 *   - only the FIRST such fence, which keepFirstRunnable would have left
 *     runnable anyway
 *
 * Everything downstream is unchanged: the command still has to be
 * read-only to run itself, still raises a dialog if it is destructive, and
 * still needs a click in every mode but accept-all.
 */
export function normaliseFences(text: string): string {
  if (/```wumpy-(run|ask|write|search)/.test(text)) return text

  const SHELLS: Array<[RegExp, string]> = [
    [/^(\s*```)(powershell|pwsh|ps1|ps)(\s*)$/i, 'wumpy-run'],
    [/^(\s*```)(cmd|bat|batch)(\s*)$/i, 'wumpy-run-cmd'],
    [/^(\s*```)(bash|sh|shell)(\s*)$/i, 'wumpy-run-bash']
  ]

  let done = false
  return text
    .split(String.fromCharCode(10))
    .map((line) => {
      if (done) return line
      for (const [pattern, tag] of SHELLS) {
        const m = pattern.exec(line)
        if (m) {
          done = true
          return `${m[1]}${tag}${m[3]}`
        }
      }
      return line
    })
    .join(String.fromCharCode(10))
}

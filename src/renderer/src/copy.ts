/**
 * Copying text, and knowing whether it worked.
 *
 * `navigator.clipboard.writeText` requires the document to have focus. This
 * window frequently does not: that is the autofocus saga in one sentence, and
 * the log has `hasFocus=false caretHere=true` on a panel the user was typing
 * into. So the three Copy paths in the app were a coin toss, and the one on
 * Ctrl+Shift+C said "Copied the last answer." whether or not anything had
 * been copied:
 *
 *   ERROR [renderer] Uncaught (in promise) NotAllowedError: Failed to execute
 *   'writeText' on 'Clipboard': Write permission denied.
 *
 * Electron's clipboard, in the main process, has no focus requirement. So
 * that is the route, with the page's own API kept only as a fallback for a
 * preload that predates the channel - and the result is returned rather than
 * assumed, so nothing claims a copy it did not make.
 */
export async function copyText(text: string): Promise<boolean> {
  const out = (text ?? '').trim()
  if (!out) return false
  try {
    const ok = await window.wumpy?.clipboard?.write(out)
    if (ok) return true
  } catch {
    /* fall through to the page's own clipboard */
  }
  try {
    await navigator.clipboard.writeText(out)
    return true
  } catch {
    /* Both routes refused. The caller says so rather than pretending. */
    return false
  }
}

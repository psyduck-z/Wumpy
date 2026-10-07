import { shell } from 'electron'
import { checkLink, searchUrl, type SearchEngine } from '@shared/links'
import type { LinkResult } from '@shared/types'

/**
 * The one place in Wumpy that can reach the browser.
 *
 * Everything that opens a link comes through here, and this re-checks it even
 * when the caller already did. The renderer's checks are for telling the user
 * what will happen; this one is the one that decides, because a renderer is
 * reachable from a model's output and a main process is not. A check in the
 * renderer alone would be a check an injected link could route around.
 *
 * It is also deliberately the only call to `shell.openExternal` in the app -
 * asserted by scripts/check-links.mjs - because that function is not "open a web
 * page". On Windows the string goes to the shell, which launches whatever program
 * has claimed the scheme.
 */
export async function openLink(raw: string): Promise<LinkResult> {
  const check = checkLink(raw)
  if (!check.ok) {
    console.warn(`[wumpy] refused to open ${JSON.stringify(raw.slice(0, 120))}: ${check.why}`)
    return { opened: false, url: '', host: '', error: check.why ?? 'That link cannot be opened.' }
  }

  try {
    await shell.openExternal(check.url)
    console.log(`[wumpy] opened ${check.host}`)
    return { opened: true, url: check.url, host: check.host }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Windows would not open it.'
    return { opened: false, url: check.url, host: check.host, error: detail }
  }
}

/** Opens a search for a query, in the engine the user chose. */
export function openSearch(query: string, engine: SearchEngine): Promise<LinkResult> {
  return openLink(searchUrl(query, engine))
}

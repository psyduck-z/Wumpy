/**
 * Deciding whether a link may be handed to the operating system.
 *
 * `shell.openExternal` is not "open a web page". On Windows it hands the string
 * to the shell, which looks up the scheme in the registry and launches whatever
 * is registered for it - so `ms-settings:`, `steam:`, `slack:`, and every other
 * protocol any installed program has claimed. A `file://` URL opens a local file
 * or a UNC path, which can reach a remote SMB server and take credentials with
 * it. None of that is a web page, and none of it is something a model should be
 * able to reach by writing a link.
 *
 * That matters here more than it would in most apps, because this one searches
 * the web. Anything the model reads can contain instructions, so a URL in an
 * answer may be something a page told it to open rather than something it chose.
 * Which is also why a URL it invents is never opened without a click, while a
 * search this app builds from a query is.
 *
 * So: http and https, nothing else, ever. Not refused-with-a-prompt - refused.
 */

export interface LinkCheck {
  /** True when this may be opened at all, possibly after a click. */
  ok: boolean
  /** The normalised URL to open. Empty when refused. */
  url: string
  /**
   * The host as a browser resolves it.
   *
   * Taken from the parsed URL rather than the text, so it is already punycoded:
   * a homograph like "аpple.com" with a Cyrillic а shows up as "xn--pple-43d.com"
   * instead of looking exactly like the real thing on the card.
   */
  host: string
  /** Why it was refused, for the card to show. Null when it was not. */
  why: string | null
  /**
   * True when the host is not reachable from outside this machine.
   *
   * Not a refusal - localhost:3000 is a reasonable thing to want open. It does
   * rule out opening without a click, because a router's admin page or a local
   * dev server is exactly what an injected link would aim at.
   */
  local: boolean
}

const MAX_LENGTH = 2048

/** The only two schemes that mean "a web page". */
const ALLOWED = new Set(['http:', 'https:'])

function refuse(why: string): LinkCheck {
  return { ok: false, url: '', host: '', why, local: false }
}

/**
 * Hosts that only exist on this machine or this network.
 *
 * Deliberately crude: it is deciding whether a click is required, not whether
 * something is safe, so over-matching costs one keypress.
 */
function isLocal(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  if (!h.includes('.')) return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h))
    return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  // 0.0.0.0 and friends.
  if (/^0\./.test(h)) return true
  return false
}

/**
 * True when text looks like somewhere to go rather than something to search for.
 *
 * `/open` takes either, so this is what tells them apart. A phrase with no dot
 * is a search; a Windows path is neither and must not be talked into being a URL
 * by prefixing a scheme.
 */
export function looksLikeUrl(raw: string): boolean {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return false
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return true
  // A bare host needs a dot and a plausible last label.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(text)
}

/** Checks one link. Never throws; a bad link comes back refused with a reason. */
export function checkLink(raw: string): LinkCheck {
  const text = raw.trim()
  if (!text) return refuse('There is no link here.')
  if (text.length > MAX_LENGTH) return refuse('That link is too long to be real.')
  // A link with a newline or control character in it is being disguised.
  if (/[\u0000-\u001f\u007f]/.test(text)) return refuse('That link has control characters in it.')

  /**
   * A backslash is never part of a link worth opening, and it is how a path is
   * talked into looking like one: the URL parser treats backslashes as slashes
   * for http and https, so prefixing a scheme turned `\\attacker\share` into
   * `https://attacker/share` - a different destination entirely, arrived at
   * silently.
   */
  if (text.includes('\\')) return refuse('That is a file path, not a link.')

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return refuse('That is not a link.')
  }

  if (!ALLOWED.has(url.protocol)) {
    // Named rather than described, because "blocked" with no reason reads as a
    // bug and the scheme is the whole point.
    return refuse(
      url.protocol === 'file:'
        ? 'Refused: file:// links open local files, not web pages.'
        : `Refused: Wumpy only opens http and https links, not ${url.protocol.replace(':', '')}:.`
    )
  }

  // user:pass@host is how a link is made to look like it goes somewhere else.
  if (url.username || url.password) {
    return refuse('Refused: that link has a username hidden in it.')
  }
  if (!url.hostname) return refuse('That link has no site in it.')

  return {
    ok: true,
    url: url.toString(),
    host: url.hostname,
    why: null,
    local: isLocal(url.hostname)
  }
}

/* ------------------------------------------------------------------ searching */

export const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' }
} as const

export type SearchEngine = keyof typeof SEARCH_ENGINES

export function isSearchEngine(name: string): name is SearchEngine {
  return name in SEARCH_ENGINES
}

/**
 * Builds a search URL from a query.
 *
 * encodeURIComponent, not a template: a query is user or model text and may
 * contain anything, and a `#` would otherwise silently truncate it while a
 * `&` would add parameters the caller never wrote.
 */
export function searchUrl(query: string, engine: SearchEngine = 'duckduckgo'): string {
  return SEARCH_ENGINES[engine].url + encodeURIComponent(query.trim())
}

/* -------------------------------------------------------------- auto-opening */

export type LinkApproval = 'manual' | 'auto' | 'all'

/**
 * Whether a link may open without the user clicking.
 *
 * The distinction is who wrote the URL. A search is built here from a query, so
 * the destination is a search engine whatever the query says - at worst an odd
 * search. A URL from the model is a destination it chose, and since this app
 * feeds it web pages, "it chose" can mean "a page told it to": a link with the
 * conversation in its query string would be an exfiltration channel that opened
 * itself. So that one waits for a click unless the user has turned on accept-all
 * and said, explicitly, that they want this.
 */
export function linkOpensItself(
  check: LinkCheck,
  source: 'search' | 'model',
  mode: LinkApproval
): boolean {
  if (!check.ok) return false
  // A dev server or a router admin page is what an injected link would aim at.
  if (check.local) return false
  if (mode === 'all') return true
  if (mode === 'auto') return source === 'search'
  return false
}

/* ---------------------------------------------------------- what the model wrote */

export interface LinkRequest {
  /** The reason line, which the card shows. */
  reason: string | null
  /** A query to search for, when the model asked for a search. */
  query: string | null
  /** A URL to open, when it asked for one directly. */
  target: string | null
}

/**
 * Reads a `wumpy-open` block.
 *
 * Same shape as every other proposal in this app: `#` lines are the reason, and
 * one payload line. `search: <words>` asks for a search, anything else is a URL -
 * which keeps the model from having to know how to build a search URL, and keeps
 * this app in charge of where searches go.
 */
export function readLinkRequest(raw: string): LinkRequest {
  const lines = raw.split('\n')
  const reason = lines
    .filter((l) => l.trim().startsWith('#'))
    .map((l) => l.replace(/^\s*#+\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
  const body = lines
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => l.trim())
    .filter(Boolean)

  const first = body[0] ?? ''
  const search = /^search:\s*(.+)$/i.exec(first)

  /**
   * A search whose query is a link is a link.
   *
   * Measured on llama3.2:3b, asked to open google.com: `search:
   * https://www.google.com` twice out of three, and `search: google.com` the
   * rest. Taken literally that searches DuckDuckGo for the address instead of
   * going there - the user asked to open a page and got a results page about
   * it, which looks like the app ignoring them.
   *
   * Only an unambiguous address is promoted. "search: how do i open google"
   * stays a search, because a query with spaces in it is a query.
   */
  if (search) {
    const query = search[1].trim()
    if (looksLikeUrl(query)) {
      return { reason: reason || null, query: null, target: stripMarkdown(query) || null }
    }
    return { reason: reason || null, query: query || null, target: null }
  }

  return {
    reason: reason || null,
    query: null,
    // Markdown often arrives as <https://…> or [text](url); take the URL.
    target: stripMarkdown(first) || null
  }
}

/**
 * Gets the link out of a line that has a link in it somewhere.
 *
 * A small model does not reliably put the URL on a line by itself. Observed in
 * use: `https://www.google.com float: right`, which was refused with "That is
 * not a link" when the link was plainly right there. The same shape turns up
 * as a trailing full stop, a markdown link, angle brackets, or a few words of
 * commentary the model could not resist adding.
 *
 * Taking the first http(s) token out of the line is safe to do here because
 * nothing is opened on the strength of it: the result still goes through
 * checkLink, the host is shown on the card, and on the manual approval mode
 * the user clicks. Extracting is strictly better than refusing, because
 * refusing leaves them with a proposal they can see is correct and cannot act
 * on.
 */
function stripMarkdown(text: string): string {
  const link = /\[[^\]]*\]\(([^)\s]+)\)/.exec(text)
  if (link) return link[1]

  const trimmed = text.trim()
  // Already one token: the common case, and the only one where a bare host
  // with no scheme is still acceptable.
  if (!/\s/.test(trimmed)) {
    return trimmed
      .replace(/^<|>$/g, '')
      .replace(/[.,;:)]+$/, '')
      .trim()
  }

  // Several tokens. Only an explicit http(s) URL is worth digging out - a bare
  // word with a dot in it is as likely to be the end of a sentence as a host.
  const url = /\bhttps?:\/\/[^\s<>"']+/i.exec(trimmed)
  if (url)
    return url[0]
      .replace(/^<|>$/g, '')
      .replace(/[.,;:)]+$/, '')
      .trim()

  return trimmed
    .replace(/^<|>$/g, '')
    .replace(/[.,;:)]+$/, '')
    .trim()
}

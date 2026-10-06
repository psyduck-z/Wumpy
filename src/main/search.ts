import type { SearchResult } from '@shared/types'

const MAX_RESULTS = 6
const TIMEOUT_MS = 15_000
const UA = 'Wumpy/0.1 (local tray assistant)'

export interface SearchOutcome {
  results: SearchResult[]
  /** Which source answered, for the card and for the model's benefit. */
  provider: 'brave' | 'duckduckgo' | 'wikipedia' | 'none'
  error?: string
}

/**
 * Web search.
 *
 * Scraping DuckDuckGo's HTML pages was tried first and abandoned: it worked for
 * a handful of requests and then returned HTTP 202 with an anti-bot challenge
 * on every call. A feature that breaks the moment it is used is worse than one
 * with stated limits, so everything here is a documented endpoint.
 *
 * Without a key this covers encyclopedic questions — definitions, people,
 * places, concepts — via DuckDuckGo's Instant Answer API and Wikipedia. It does
 * not cover general web results: "ollama keep_alive" returns nothing from
 * either. Set `searchApiKey` to a Brave Search key for real web results; Brave
 * has a free tier and is the only part of this that needs an account.
 */
export async function webSearch(query: string, apiKey?: string): Promise<SearchOutcome> {
  const trimmed = query.trim()
  if (!trimmed) return { results: [], provider: 'none', error: 'Empty query.' }

  if (apiKey) {
    const brave = await searchBrave(trimmed, apiKey)
    if (brave.results.length > 0) return brave
    // A bad key or a spent quota should say so rather than silently degrade.
    if (brave.error) return brave
  }

  const instant = await searchInstantAnswer(trimmed)
  if (instant.results.length > 0) return instant

  const wiki = await searchWikipedia(trimmed)
  if (wiki.results.length > 0) return wiki

  return {
    results: [],
    provider: 'none',
    error: apiKey
      ? 'No results.'
      : 'No results. Without a search API key only encyclopedic questions are covered — set `searchApiKey` in settings for general web search.'
  }
}

/* ------------------------------------------------------------------- brave */

async function searchBrave(query: string, apiKey: string): Promise<SearchOutcome> {
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(MAX_RESULTS))

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (res.status === 401 || res.status === 403) {
      return { results: [], provider: 'brave', error: 'Search API key was rejected.' }
    }
    if (res.status === 429) {
      return { results: [], provider: 'brave', error: 'Search API quota reached.' }
    }
    if (!res.ok) {
      return { results: [], provider: 'brave', error: `Search API returned HTTP ${res.status}.` }
    }

    const body = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
    }
    const results = (body.web?.results ?? [])
      .filter((r) => r.title && r.url)
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: strip(r.title ?? ''),
        url: r.url ?? '',
        snippet: strip(r.description ?? '').slice(0, 300)
      }))
    return { results, provider: 'brave' }
  } catch (err) {
    return { results: [], provider: 'brave', error: describe(err) }
  }
}

/* ---------------------------------------------------------- instant answer */

async function searchInstantAnswer(query: string): Promise<SearchOutcome> {
  try {
    const url = new URL('https://api.duckduckgo.com/')
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('no_html', '1')
    url.searchParams.set('skip_disambig', '1')

    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return { results: [], provider: 'duckduckgo' }

    const body = (await res.json()) as {
      Heading?: string
      AbstractText?: string
      AbstractURL?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
      Results?: Array<{ Text?: string; FirstURL?: string }>
    }

    const results: SearchResult[] = []
    if (body.AbstractText) {
      results.push({
        title: body.Heading || query,
        url: body.AbstractURL || '',
        snippet: strip(body.AbstractText).slice(0, 400)
      })
    }
    // Direct results first, then the related-topic list.
    for (const item of [...(body.Results ?? []), ...(body.RelatedTopics ?? [])]) {
      if (results.length >= MAX_RESULTS) break
      if (!item.Text || !item.FirstURL) continue
      const text = strip(item.Text)
      results.push({
        // Related topics come as "Title - description" in one field.
        title: text.split(' - ')[0].slice(0, 90),
        url: item.FirstURL,
        snippet: text.slice(0, 300)
      })
    }
    return { results, provider: 'duckduckgo' }
  } catch {
    return { results: [], provider: 'duckduckgo' }
  }
}

/* --------------------------------------------------------------- wikipedia */

async function searchWikipedia(query: string): Promise<SearchOutcome> {
  try {
    const url = new URL('https://en.wikipedia.org/w/api.php')
    url.searchParams.set('action', 'query')
    url.searchParams.set('list', 'search')
    url.searchParams.set('srsearch', query)
    url.searchParams.set('srlimit', String(MAX_RESULTS))
    url.searchParams.set('format', 'json')

    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return { results: [], provider: 'wikipedia' }

    const body = (await res.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> }
    }
    const results = (body.query?.search ?? []).map((hit) => ({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      snippet: strip(hit.snippet).slice(0, 300)
    }))
    return { results, provider: 'wikipedia' }
  } catch {
    return { results: [], provider: 'wikipedia' }
  }
}

/* ----------------------------------------------------------------- helpers */

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'Search timed out.'
    if (/fetch failed/i.test(err.message)) return 'No internet connection.'
    return err.message
  }
  return String(err)
}

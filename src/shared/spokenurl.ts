/**
 * Web addresses that were spoken out loud.
 *
 * Dictating a URL is the one thing in this app where a wrong transcript cannot
 * be caught by reading it. "Make a pithon file" is obvious. A join code that
 * came out as 1-2-3-4-5-6 instead of 123456 looks completely reasonable, right
 * up to the 404 - and so does 12345 if a digit was dropped, which is why this
 * module never silently invents one.
 *
 * Measured against the tables in dictation.ts before this existed, a single
 * dictated address went wrong in five places at once:
 *
 *   said:   "https vocabulary.com slash join slash <six digits>"
 *   heard:  "https vocabulary.com slash join slash 1-2-3-4-5-6"
 *   tidied: "Https vocabulary.com slash join slash 1-2-3-4-5-6"
 *
 * No scheme, no slashes, the digits hyphenated, and a capital H on the front
 * because the last rule in the pass capitalises a sentence. The hyphens were
 * what got noticed, but nothing else was right either.
 *
 * Two of those five are Whisper and three are us. Whisper writes a dictated
 * digit run the way a subtitle would - "1-2-3-4-5-6", "1 2 3 4 5 6", "123 456",
 * or spelled out in words - because that is what its training data did with
 * phone numbers. The rest is this app never having had a rule for "slash",
 * "dot com" or "colon slash slash", because the tables were written for prose.
 *
 * So addresses are taken out of the sentence FIRST, repaired on their own terms,
 * and put back as opaque tokens that the prose tables cannot touch. That
 * ordering is not tidiness: /json in a path would otherwise be shouted into
 * /JSON by the vocabulary table, and "github dot com" became "GitHub dot com"
 * before a single slash was fixed.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 *
 * Join "123-456". A six-digit code dictated in two groups of three and a real
 * hyphenated code look identical, and guessing wrong produces an address that
 * is confidently, invisibly broken. Single digits separated by hyphens are
 * different: no human writes a code that way, so 1-2-3-4-5-6 is Whisper's
 * formatting and nothing else. Spaces and commas between digits are joined
 * unconditionally, because a URL cannot contain either.
 *
 * Everything here is pure, so the checks can run a hundred dictated addresses
 * through it without a microphone. Run them with: npm run check:spoken
 */

/**
 * The stand-in for an address while the prose tables run.
 *
 * A private-use codepoint rather than a word, because the placeholder has to
 * survive a table that rewrites words: anything made of letters is something
 * the vocabulary pass might decide is a model name. It also has to be
 * something the "capitalise the first letter" rule will not touch, which rules
 * out every plain-text marker that starts with one.
 */
const MARK = String.fromCharCode(0xe000)

/** Top-level domains people actually dictate. A host needs one to be a host. */
const TLDS = new Set(
  (
    'com net org io dev co ai app me edu gov mil int info biz xyz online site tech cloud ' +
    'store shop blog wiki news help docs page link live life world space press team group ' +
    'global digital design studio agency academy school media games sport uk us ca de fr ' +
    'jp in au nz eu ie dk fi pt gr tr il sg hk kr tw my th id ph vn pk bd lk ae sa za mx ' +
    'br cn ru ch it nl se no es pl cz at be lu ro hu bg hr rs ua ar cl pe tv fm gg sh so ' +
    'to ly am fo gl is mt cy ee lv lt si sk md by kz ge az al mk ba'
  ).split(' ')
)

/**
 * Hosts that mean an email address rather than a web page.
 *
 * Needed because "<word> at <host>" is also an ordinary English sentence. See
 * `spokenEmail` for the rest of the guard.
 */
const MAIL_HOSTS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
  'qq.com',
  '163.com'
])

/**
 * Words that are not hostnames, however many dots follow them.
 *
 * Found by running ordinary sentences through this module: "the dot com bubble
 * burst in 2000" became "the.com bubble burst in 2000", "look at this dot org
 * report" became "this.org", and "tell me about dot net" became "about.net".
 * All three are the same shape as "vocabulary dot com" and none of them is an
 * address.
 *
 * about.com is a real site, so this is a trade rather than a rule: a function
 * word is allowed to be a host when the sentence goes on to prove it, with a
 * scheme in front or a path after. "go to about dot com slash contact" still
 * works; "the dot com bubble" is left as the words it was.
 */
const NOT_A_HOST = new Set(
  (
    'the this that these those a an and or but of in on at to for from with by is was are be ' +
    'been it its what which who whom whose my your his her their our me you we they he she i ' +
    'all any some no not up down out off over under here there now then so such just only ' +
    'very more most less as if when while because about above below after before again both ' +
    'each few other same too own why how where whether every another one two three four five'
  ).split(' ')
)

/**
 * Words that come before "at" in a sentence about a place.
 *
 * "look at gmail.com" is not an email address, and the only thing that
 * separates it from "zechariah at gmail.com" is which word is on the left.
 */
const NOT_A_LOCAL_PART = new Set([
  'look',
  'looked',
  'looking',
  'sign',
  'signed',
  'log',
  'logged',
  'login',
  'stay',
  'staying',
  'meet',
  'meeting',
  'available',
  'arrive',
  'arrived',
  'start',
  'starts',
  'started',
  'live',
  'lives',
  'living',
  'work',
  'works',
  'working',
  'based',
  'located',
  'found',
  'posted',
  'hosted',
  'running',
  'listening',
  'it',
  'me',
  'us',
  'him',
  'her',
  'them',
  'back',
  'here',
  'there',
  'now',
  'today',
  'once',
  'again',
  'all',
  'least',
  'most',
  'home',
  'school',
  'work'
])

/**
 * Spoken punctuation, inside an address only.
 *
 * "point" and "period" mean a dot here, which they do not in prose - which is
 * exactly why this table is applied to a span already known to be an address
 * rather than to the whole sentence.
 */
const SEPARATORS: Record<string, string> = {
  slash: '/',
  stroke: '/',
  dot: '.',
  point: '.',
  period: '.',
  dash: '-',
  hyphen: '-',
  minus: '-',
  underscore: '_',
  colon: ':',
  hash: '#',
  pound: '#',
  equals: '=',
  equal: '=',
  ampersand: '&',
  plus: '+',
  tilde: '~',
  percent: '%'
}

/** Spoken punctuation that takes two words to say. */
const PAIRS: Record<string, string> = {
  'forward slash': '/',
  'question mark': '?',
  'at sign': '@',
  'double slash': '//',
  'under score': '_'
}

/**
 * Digits as words.
 *
 * "oh" is here because people say it for zero in a code, and "for"/"ate" are
 * here because that is what Whisper returns for four and eight next to other
 * digits. All three are only ever consulted inside an address, and only in a
 * run of two or more - a lone "one" in a path is far more likely to be the
 * word one.
 */
const DIGITS: Record<string, string> = {
  zero: '0',
  oh: '0',
  o: '0',
  nought: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  for: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9'
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
/** A host as Whisper already assembled it, with an optional port and path. */
const LITERAL_HOST = /^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(:\d{2,5})?([/?#].*)?$/i
/** A host that only means anything with a scheme in front of it: localhost:5173. */
const BARE_HOST = /^([a-z0-9][a-z0-9-]*)(:\d{2,5})?([/?#].*)?$/i
/** One path segment, as one spoken word. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~%+-]*$/
/** A fragment that starts with punctuation, so it belongs to whatever precedes it. */
const ATTACHED = /^[/?#=&.-][^\s]*$/
/** Sentence punctuation, which is never the last character of a dictated URL. */
const TAIL_PUNCTUATION = /[.,!?;:)\]]+$/

/** Longer than this and it stopped being an address somewhere. */
const MAX_URL = 300

function lower(token: string | undefined): string {
  return (token ?? '').toLowerCase()
}

function isTld(label: string): boolean {
  return TLDS.has(label.toLowerCase())
}

/**
 * Joins what was one number said out loud.
 *
 * Spaces and commas go unconditionally: neither can appear in a URL, so their
 * presence between two digits is proof of formatting rather than content. Single
 * digits joined by hyphens go too, because no real code is written that way.
 * Everything else - 123-456, 1234-5678 - is left exactly as heard, because
 * there is no way to tell it from a code that really does have a hyphen in it.
 */
export function joinSpokenDigits(path: string): string {
  return path
    .replace(/(\d)[\s,]+(?=\d)/g, '$1')
    .replace(/(?<![\w-])\d(?:-\d){2,}(?![\w-])/g, (run) => run.split('-').join(''))
}

/** "double you double you double you" and friends, which all mean www. */
function fixWww(line: string): string {
  return line
    .replace(/\b(?:double\s*(?:you|u|ya|yoo)\s*){3}/gi, 'www ')
    .replace(/\btriple\s+(?:double\s*)?(?:you|u|w|dub)\b/gi, 'www')
    .replace(/\bw[\s.]+w[\s.]+w\b/gi, 'www')
}

interface Scheme {
  scheme: string
  next: number
}

/**
 * "https", "https:", "https colon slash slash" - all the ways a scheme arrives.
 *
 * Returning the scheme does not commit to anything: a scheme with no host after
 * it is someone talking about HTTPS, and the caller puts the words back.
 */
function readScheme(parts: string[], i: number): Scheme | null {
  const token = lower(parts[i]).replace(TAIL_PUNCTUATION, '')
  const spelled = /^h[-.]?t[-.]?t[-.]?p[-.]?(s?)$/i.exec(token)
  const plain = /^(https?)(?::?\/*)?$/i.exec(token)
  if (!plain && !spelled) return null
  const scheme = plain ? plain[1].toLowerCase() : `http${spelled![1] ? 's' : ''}`

  let j = i + 1
  // The separator, in however many pieces it was said.
  while (j < parts.length && /^(?:colon|slash|:|\/|\/\/|:\/\/|:\/)$/i.test(lower(parts[j]))) j++
  return { scheme, next: j }
}

interface Host {
  host: string
  /** A path Whisper had already attached to the host token. */
  tail: string
  next: number
  /** A scheme the host token carried itself. */
  scheme: string
}

/**
 * The host, whether Whisper wrote it or the user spelled it out.
 *
 * A host with no scheme has to end in a real TLD. "notes dot py" is a filename
 * and ".py" is the extensions table's business, not this module's.
 */
function readHost(parts: string[], i: number, scheme: string): Host | null {
  const first = parts[i]
  if (!first) return null

  const carried = /^(https?):\/\/(.+)$/i.exec(first.replace(TAIL_PUNCTUATION, ''))
  const token = (carried ? carried[2] : first).replace(TAIL_PUNCTUATION, '')
  const own = carried ? carried[1].toLowerCase() : ''
  const known = own || scheme

  const literal = LITERAL_HOST.exec(token)
  if (literal) {
    const labels = literal[1].split('.')
    if (known || isTld(labels[labels.length - 1])) {
      return {
        host: literal[1] + (literal[2] ?? ''),
        tail: literal[3] ?? '',
        next: i + 1,
        scheme: own
      }
    }
  }

  /*
   * A host with no dot in it, which only exists on this machine.
   *
   * http://localhost:5173 is an ordinary thing to dictate, but a scheme is not
   * licence to treat the next word as a host: "is this https or http" was
   * becoming "https://or http", because "or" followed a scheme. So a dotless
   * host needs a port, or a name that means this machine, or a scheme the
   * token carried itself - someone saying "http://myserver/logs" in one breath
   * has already told us it is a host.
   */
  if (known) {
    const bare = BARE_HOST.exec(token)
    const local = bare && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(bare[1])
    if (bare && !SEPARATORS[lower(bare[1])] && (own || bare[2] || local)) {
      return {
        host: bare[1] + (bare[2] ?? ''),
        tail: bare[3] ?? '',
        next: i + 1,
        scheme: own
      }
    }
  }

  // Spelled out: "vocabulary dot com", "example dot co dot uk".
  if (!LABEL.test(token)) return null
  const labels = [token]
  let j = i + 1
  // The label is read without its trailing punctuation, so "vocabulary dot
  // com, then sign in" is still a host - the comma belongs to the sentence and
  // is given back to it by readUrl.
  while (j + 1 < parts.length && SEPARATORS[lower(parts[j])] === '.') {
    const label = (parts[j + 1] ?? '').replace(TAIL_PUNCTUATION, '')
    if (!LABEL.test(label)) break
    labels.push(label)
    j += 2
  }
  if (labels.length < 2) return null

  /* A dotted quad is a host too: a router's admin page is a reasonable thing
     to dictate, and 192.168.1.1 has no TLD to recognise. */
  const quad = labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label))
  if (!isTld(labels[labels.length - 1]) && !quad) return null

  // A function word needs the sentence to prove it is a host. See NOT_A_HOST.
  if (!known && NOT_A_HOST.has(labels[0].toLowerCase())) {
    const next = parts[j] ?? ''
    const proves = SEPARATORS[lower(next)] === '/' || lower(next) === 'forward' || /^[/?#]/.test(next)
    if (!proves) return null
  }

  return { host: labels.join('.'), tail: '', next: j, scheme: own }
}

/**
 * A run of digits said one at a time.
 *
 * Two or more, because that is what makes it a code rather than a word. A path
 * segment of "/one" survives; "/one two three" becomes "/123".
 */
function readDigitRun(parts: string[], i: number): { digits: string; next: number } | null {
  let j = i
  let digits = ''
  while (j < parts.length) {
    const word = lower(parts[j]).replace(TAIL_PUNCTUATION, '')
    if (/^\d+$/.test(word)) digits += word
    else if (DIGITS[word] !== undefined) digits += DIGITS[word]
    else break
    j++
  }
  if (j - i < 2 || digits.length < 2) return null
  return { digits, next: j }
}

interface Found {
  url: string
  /** Sentence punctuation that was attached to the end and is not part of it. */
  punctuation: string
  next: number
}

/**
 * Reads one address starting at `i`, or returns null.
 *
 * The rule that decides where an address ENDS is the only interesting part: a
 * plain word is taken as a path segment only when something separating came
 * just before it. So "…/join/123456 and then tell me" stops at the code,
 * because "and" follows a segment rather than a slash - while
 * "…/psyduck dash z slash wumpy" keeps going, because every word in it is
 * introduced by punctuation.
 */
function readUrl(parts: string[], i: number): Found | null {
  let scheme = ''
  let j = i
  const head = readScheme(parts, i)
  if (head) {
    scheme = head.scheme
    j = head.next
  }

  const host = readHost(parts, j, scheme)
  if (!host) return null
  if (host.scheme) scheme = host.scheme

  let path = host.tail
  j = host.next
  let openSep = path === '' ? false : /[/?#=&.\-_]$/.test(path)

  while (j < parts.length) {
    const pair = PAIRS[`${lower(parts[j])} ${lower(parts[j + 1])}`]
    if (pair !== undefined) {
      path += pair
      j += 2
      openSep = true
      continue
    }

    const word = lower(parts[j]).replace(TAIL_PUNCTUATION, '')
    const separator = SEPARATORS[word]
    if (separator !== undefined) {
      path += separator
      j++
      openSep = true
      continue
    }

    if (openSep) {
      const run = readDigitRun(parts, j)
      if (run) {
        path += run.digits
        j = run.next
        openSep = false
        continue
      }
      if (SEGMENT.test(parts[j])) {
        path += parts[j]
        j++
        openSep = false
        continue
      }
    }

    // "/join/123" arriving as one token, punctuation and all.
    if (ATTACHED.test(parts[j])) {
      path += parts[j]
      j++
      openSep = /[/?#=&.\-_]$/.test(parts[j - 1])
      continue
    }

    break
  }

  const assembled = (scheme ? `${scheme}://` : '') + host.host.toLowerCase() + path
  if (assembled.length > MAX_URL) return null

  /*
   * The full stop at the end of "the site is vocabulary.com." belongs to the
   * sentence, and it was being swallowed: the host is read without its
   * punctuation, so by the time the address is assembled the stop is simply
   * gone. Whichever of the two places it survived in, it goes back in the text.
   */
  const inside = TAIL_PUNCTUATION.exec(assembled)?.[0] ?? ''
  const punctuation = inside || (TAIL_PUNCTUATION.exec(parts[j - 1] ?? '')?.[0] ?? '')
  const url = inside ? assembled.slice(0, -inside.length) : assembled
  const cut = url.indexOf('/')
  const body = cut === -1 ? url : url.slice(0, cut)
  const rest = cut === -1 ? '' : joinSpokenDigits(url.slice(cut))
  return { url: body + rest, punctuation, next: j }
}

/**
 * Words that make what follows an address rather than a verb's object.
 *
 * "send it TO zechariah at gmail dot com" is an address; "please register at
 * gmail.com" is not, and the only difference is the word in front.
 */
const EMAIL_CUES = new Set([
  'email',
  'e-mail',
  'mail',
  'address',
  'is',
  'its',
  "it's",
  'to',
  'from',
  'cc',
  'bcc'
])

interface Address {
  address: string
  /** How many tokens before the "at" belong to the address. */
  back: number
  punctuation: string
  next: number
}

/**
 * An email address, read outward from the word "at".
 *
 * "zechariah at gmail dot com" and "look at gmail.com" are the same shape, and
 * writing look@gmail.com into the box would be worse than leaving the words
 * alone. So the local part is read BACKWARDS from the "at" and has to survive
 * three tests: no two bare words in a row, because "sign in at gmail.com" is a
 * sentence; the word next to the "at" is not one English puts there, which is
 * what kills "look at" and "meet me at"; and then either the whole line is the
 * address, or the host is one people actually have mailboxes at AND the local
 * part has digits or punctuation of its own or a cue word in front of it.
 *
 * That last clause is what lets "my email is jamie680 at gmail dot com" work
 * in the middle of a sentence, which is how anyone signing up for something
 * would say it, while "please register at gmail.com" is left as words.
 */
function readEmail(parts: string[], at: number): Address | null {
  const marker = lower(parts[at]).replace(TAIL_PUNCTUATION, '')
  if (marker !== 'at' && marker !== '@') return null
  const after = lower(parts[at + 1]) === 'sign' ? at + 2 : at + 1
  if (at < 1 || after >= parts.length) return null

  // Backwards, because the local part is whatever ends where the "at" begins.
  const run: string[] = []
  let k = at - 1
  let rightWasWord = false
  while (k >= 0) {
    const raw = parts[k]
    const word = lower(raw).replace(TAIL_PUNCTUATION, '')
    const separator = SEPARATORS[word]
    if (separator !== undefined && separator !== '/' && separator !== ':') {
      run.unshift(separator)
      rightWasWord = false
      k--
      continue
    }
    const digit = /^\d+$/.test(word) ? word : DIGITS[word]
    if (digit !== undefined && separator === undefined) {
      run.unshift(digit)
      rightWasWord = false
      k--
      continue
    }
    // Two bare words in a row is a sentence, not a mailbox name.
    if (separator === undefined && !rightWasWord && SEGMENT.test(raw) && !raw.includes(MARK)) {
      run.unshift(word)
      rightWasWord = true
      k--
      continue
    }
    break
  }

  const start = k + 1
  const local = run.join('')
  if (!local || start >= at) return null
  if (/^[.\-_]|[.\-_]$/.test(local)) return null
  if (NOT_A_LOCAL_PART.has(lower(parts[start]).replace(TAIL_PUNCTUATION, ''))) return null

  const host = readHost(parts, after, '')
  if (!host || host.tail) return null
  // A path after the host makes it a web address, not an email one.
  const follows = parts[host.next] ?? ''
  if (SEPARATORS[lower(follows)] === '/' || /^[/?#]/.test(follows)) return null

  const domain = host.host.toLowerCase()
  const mailbox = MAIL_HOSTS.has(domain)
  const ownPunctuation = /[._\-\d]/.test(local)
  const wholeLine = start === 0 && host.next === parts.length
  const cue = start > 0 ? lower(parts[start - 1]).replace(TAIL_PUNCTUATION, '') : ''
  const believable = wholeLine
    ? mailbox || ownPunctuation
    : mailbox && (ownPunctuation || EMAIL_CUES.has(cue))
  if (!believable) return null

  return {
    address: `${local}@${domain}`,
    back: at - start,
    punctuation: TAIL_PUNCTUATION.exec(parts[host.next - 1] ?? '')?.[0] ?? '',
    next: host.next
  }
}

/** The first email address in a line, or null. See `readEmail`. */
export function spokenEmail(line: string): string | null {
  const parts = fixWww(line.trim()).split(/\s+/).filter(Boolean)
  for (let i = 1; i < parts.length - 1; i++) {
    const found = readEmail(parts, i)
    if (found) return found.address
  }
  return null
}

export interface Masked {
  /** The line with every address replaced by an opaque placeholder. */
  text: string
  /** The addresses, in the order their placeholders appear. */
  urls: string[]
}

/**
 * Takes the addresses out of a sentence, repaired.
 *
 * Call this BEFORE any table that rewrites words, and `restoreUrls` after the
 * last one. The placeholders are deliberately not words, so a pass that
 * uppercases JSON or capitalises a sentence cannot reach inside them.
 */
export function maskUrls(text: string): Masked {
  const urls: string[] = []

  const lines = text.split(String.fromCharCode(10)).map((line) => {
    const parts = fixWww(line).split(/\s+/).filter(Boolean)
    const out: string[] = []
    let i = 0
    while (i < parts.length) {
      /*
       * An email is tried first, and at the "at" rather than at its start: the
       * local part is only recognisable once the "at" has been seen. Its words
       * are already in `out` by then, so they come back off - but only if they
       * are still the plain words that went in, never a URL that was masked.
       */
      const email = readEmail(parts, i)
      if (email && out.length >= email.back && !out.slice(-email.back).some((t) => t.includes(MARK))) {
        out.length -= email.back
        urls.push(email.address)
        out.push(`${MARK}${urls.length - 1}${MARK}${email.punctuation}`)
        i = email.next
        continue
      }

      const found = readUrl(parts, i)
      if (!found) {
        out.push(parts[i])
        i++
        continue
      }
      urls.push(found.url)
      out.push(`${MARK}${urls.length - 1}${MARK}${found.punctuation}`)
      i = found.next
    }
    return out.join(' ')
  })

  return { text: lines.join(String.fromCharCode(10)), urls }
}

/** Puts the addresses back where their placeholders are. */
export function restoreUrls(text: string, urls: string[]): string {
  let out = text
  urls.forEach((url, index) => {
    out = out.split(`${MARK}${index}${MARK}`).join(url)
  })
  // A placeholder nothing claimed would be invisible on screen, so it goes.
  return out.split(MARK).join('')
}

/** Mask and restore in one go. The whole repair, with nothing in between. */
export function tidyUrls(text: string): string {
  const { text: masked, urls } = maskUrls(text)
  return restoreUrls(masked, urls)
}

/**
 * Every address in a piece of text, for comparing one version against another.
 *
 * Used by the polish guard: a model asked to punctuate a sentence has no
 * business touching a URL inside it, and a URL it has "corrected" is the one
 * kind of damage the user cannot spot by reading.
 */
export function urlsIn(text: string): string[] {
  return maskUrls(text).urls
}

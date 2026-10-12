/**
 * Dictated web addresses, and the sentences that only look like one.
 *
 * The bug this exists for: "https vocabulary.com slash join slash <six
 * digits>" came back with the digits hyphenated - 1-2-3-4-5-6 - and nothing
 * else about it fixed either. No scheme, no slashes, no .com, and a capital H
 * on the front. A wrong URL is the one transcript error reading the box cannot
 * catch, so every repair here is checked against the shape Whisper actually
 * returns.
 *
 * Half of these are addresses that must come out right. The other half are
 * sentences that must be left completely alone, because a module that turns
 * "look at gmail.com" into an email address or eats the word "and" at the end
 * of a path is worse than no module.
 *
 * Run with: npm run check:spoken
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const urlOut = '.spoken-check.mjs'
const tidyOut = '.spoken-tidy.mjs'
await build({
  entryPoints: ['src/shared/spokenurl.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: urlOut,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
await build({
  entryPoints: ['src/shared/dictation.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tidyOut,
  logLevel: 'error',
  alias: { '@shared': 'src/shared' }
})
const { tidyUrls, spokenEmail, joinSpokenDigits, urlsIn, maskUrls, restoreUrls } = await import(
  pathToFileURL(urlOut).href
)
const { tidyTranscript, polishAcceptable } = await import(pathToFileURL(tidyOut).href)
rmSync(urlOut, { force: true })
rmSync(tidyOut, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(got)}` +
      (ok ? '' : `${String.fromCharCode(10)}     expected ${JSON.stringify(want)}`)
  )
}

const NL = String.fromCharCode(10)
const COMMANDS = ['also', 'new', 'tier', 'model', 'key', 'chats']
const tidy = (text) => tidyTranscript(text, { commands: COMMANDS })

/* ------------------------------------------------- the address that started it */

/*
 * The real one, in all five shapes Whisper returns a dictated digit run. The
 * join code is six digits and it has to be six digits in every one of them.
 */
check(
  'hyphenated single digits, the reported bug',
  tidy('https vocabulary.com slash join slash 1-2-3-4-5-6'),
  'https://vocabulary.com/join/123456'
)
check(
  'the same digits with spaces',
  tidy('https vocabulary.com slash join slash 1 2 3 4 5 6'),
  'https://vocabulary.com/join/123456'
)
check(
  'in two groups with a comma',
  tidy('https vocabulary.com slash join slash 123, 456'),
  'https://vocabulary.com/join/123456'
)
check(
  'spelled out in words',
  tidy('https colon slash slash vocabulary dot com slash join slash one two three four five six'),
  'https://vocabulary.com/join/123456'
)
check(
  'with a zero said as oh',
  tidy('vocabulary.com slash join slash four oh two one nine nine'),
  'vocabulary.com/join/402199'
)

/* --------------------------------------------------------- the rest of a URL */

check('a scheme said with no colon', tidy('https vocabulary.com'), 'https://vocabulary.com')
check(
  'a scheme said in full',
  tidy('https colon slash slash example.com'),
  'https://example.com'
)
check('http as well', tidy('http colon slash slash example.com'), 'http://example.com')
check('a host spelled out', tidy('go to vocabulary dot com'), 'Go to vocabulary.com')
check('a two-part TLD', tidy('open example dot co dot uk'), 'Open example.co.uk')
check(
  'a spoken dash in a path stays a dash',
  tidy('go to github dot com slash psyduck dash z slash wumpy'),
  'Go to github.com/psyduck-z/wumpy'
)
check(
  'an underscore too',
  tidy('open example.com slash my underscore notes'),
  'Open example.com/my_notes'
)
check(
  'a query string',
  tidy('open example.com slash search question mark q equals wumpy'),
  'Open example.com/search?q=wumpy'
)
check('www spelled as letters', tidy('go to w w w dot example dot com'), 'Go to www.example.com')
check(
  'www said as double you',
  tidy('go to double you double you double you dot example dot com'),
  'Go to www.example.com'
)
check(
  'a port needs the scheme to be a host',
  tidy('open http colon slash slash localhost colon 5173'),
  'Open http://localhost:5173'
)
check(
  'a path Whisper already assembled',
  tidy('open vocabulary.com/join/1-2-3-4-5-6'),
  'Open vocabulary.com/join/123456'
)
check(
  'and one it assembled with the scheme attached',
  tidy('https://vocabulary.com/join/1-2-3-4-5-6'),
  'https://vocabulary.com/join/123456'
)
check('the scheme is lowercased', tidy('HTTPS://Example.COM'), 'https://example.com')
check('and a shouted host', tidy('go to VOCABULARY.COM slash join'), 'Go to vocabulary.com/join')
check(
  'a file extension in a path survives',
  tidy('open example.com slash notes dot txt'),
  'Open example.com/notes.txt'
)

/* ------------------------------------------- where the address has to stop */

/*
 * The end of a URL is the whole difficulty. A word is part of the path only
 * when punctuation introduced it, so prose after a path segment ends the
 * address instead of being swallowed into it.
 */
check(
  'prose after a path is not path',
  tidy('open vocabulary.com slash join slash 123456 and then tell me what it says'),
  'Open vocabulary.com/join/123456 and then tell me what it says'
)
check(
  'a please on the end is not a path segment',
  tidy('take me to vocabulary.com slash join slash 1-2-3-4-5-6 please'),
  'Take me to vocabulary.com/join/123456 please'
)
check(
  'a host followed by a sentence',
  tidy('vocabulary dot com is the one I meant'),
  'vocabulary.com is the one I meant'
)
check(
  'a full stop stays a full stop',
  tidy('the site is vocabulary.com.'),
  'The site is vocabulary.com.'
)
check(
  'and a comma in the sentence',
  tidy('open vocabulary.com, then sign in'),
  'Open vocabulary.com, then sign in'
)

/* ------------------------------------------------ what must not be touched */

/*
 * "dot py" is the extensions table's business and it still gets it: .py is not
 * a TLD anyone dictates, so no address is found and "notes dot py" comes out
 * of the extensions pass as notes.py exactly as it did before.
 */
check(
  'a filename is not a host',
  tidy('make a file called notes dot py'),
  'Make a file called notes.py'
)
check('a version number is left alone', tidy('install node 20 dot 11'), 'Install node 20 dot 11')
check(
  'ordinary speech with and-slash-or survives',
  tidy('bring a coat and / or an umbrella'),
  'Bring a coat and / or an umbrella'
)
check('a lone slash command is untouched', tidy('slash also do this'), '/also do this')
check(
  'a sentence about https is not an address',
  tidy('is this https or http'),
  'Is this https or http'
)
check('prose with a dash keeps it', tidy('it is a well-known problem'), 'It is a well-known problem')
check(
  'a phone number in prose is not joined',
  tidy('my number is 555-123-4567'),
  'My number is 555-123-4567'
)
check('the word one in a path stays a word', tidy('open example.com slash one'), 'Open example.com/one')
check(
  'a spoken number that is a quantity',
  tidy('there are two hundred files'),
  'There are two hundred files'
)

/* ------------------------------------- function words are not hostnames */

/*
 * All three of these were real false positives, found by running ordinary
 * sentences through the module rather than by thinking about it.
 */
check(
  'the dot com bubble is not a host',
  tidy('the dot com bubble burst in 2000'),
  'The dot com bubble burst in 2000'
)
check(
  'nor this dot org',
  tidy('look at this dot org report'),
  'Look at this.org report'.replace('this.org', 'this dot org')
)
check(
  'nor about dot net',
  tidy('tell me about dot net'),
  'Tell me about dot net'
)
/* But a path proves it, because prose does not have one. */
check(
  'a path proves a host',
  tidy('go to about dot com slash contact'),
  'Go to about.com/contact'
)
check(
  'and so does a scheme',
  tidy('open https colon slash slash about dot com'),
  'Open https://about.com'
)
/* A real host that happens to read like a word still works with a path. */
check(
  'a dotted quad is a host',
  tidy('go to 192 dot 168 dot 1 dot 1'),
  'Go to 192.168.1.1'
)
check(
  'a version number is not harmed by that',
  tidy('version 1 dot 2 dot 3 dot 4'),
  'Version 1.2.3.4'
)

/* A Windows path is the other address this app gets dictated. */
check(
  'a drive letter',
  tidy('the file is at C colon back slash users back slash zecha'),
  'The file is at C:\\users\\zecha'
)
check('a colon in a sentence is untouched', tidy('the time is 5 colon 30'), 'The time is 5 colon 30')

/* ----------------------------------------------- what it refuses to guess */

/*
 * Two groups of three digits could be Whisper's formatting or a code that
 * really has a hyphen. There is no way to tell, and inventing an answer makes
 * an address that is wrong in a way reading it cannot catch - so it is left
 * exactly as heard and the user fixes it in the box if it is wrong.
 */
check('123-456 is left as heard', joinSpokenDigits('/join/123-456'), '/join/123-456')
check('and 1234-5678', joinSpokenDigits('/join/1234-5678'), '/join/1234-5678')
check('single digits are joined', joinSpokenDigits('/join/1-2-3-4-5-6'), '/join/123456')
check('two single digits are not', joinSpokenDigits('/join/1-2'), '/join/1-2')
check('spaces always go', joinSpokenDigits('/join/123 456'), '/join/123456')
check('commas always go', joinSpokenDigits('/join/123,456'), '/join/123456')
check('a hyphenated word is not a number', joinSpokenDigits('/psyduck-z/wumpy'), '/psyduck-z/wumpy')

/* --------------------------------------------------------------- addresses */

check('an email with a mail host', spokenEmail('zechariah at gmail dot com'), 'zechariah@gmail.com')
check(
  'one with punctuation in the local part',
  spokenEmail('jamie dot 680 at gmail dot com'),
  'jamie.680@gmail.com'
)
check('digits said one at a time', spokenEmail('jamie six eight zero at gmail dot com'), 'jamie680@gmail.com')
check('an at sign said as two words', spokenEmail('zechariah at sign gmail dot com'), 'zechariah@gmail.com')
check('an address Whisper assembled', spokenEmail('zechariah at gmail.com'), 'zechariah@gmail.com')

/* Mid-sentence, which is how anyone signing up for something says it. */
check(
  'an address in the middle of a sentence',
  tidy('my email is jamie680 at gmail dot com'),
  'My email is jamie680@gmail.com'
)
check(
  'one introduced by a cue word',
  tidy('send it to zechariah at gmail dot com'),
  'Send it to zechariah@gmail.com'
)
check(
  'and one with the rest of the sentence after it',
  tidy('put jamie680 at gmail dot com in the box and press enter'),
  'Put jamie680@gmail.com in the box and press enter'
)
/* The same shape, mid-sentence, that is not an address. */
check(
  'a verb before a mail host is not an address',
  tidy('please register at gmail.com'),
  'Please register at gmail.com'
)
check('nor email me at a place', tidy('email me at gmail.com'), 'Email me at gmail.com')
check(
  'nor a site that is not a mailbox',
  tidy('the tickets are at vocabulary.com'),
  'The tickets are at vocabulary.com'
)

/* The sentences that have exactly the same shape and are not addresses. */
check('look at a site is not an address', spokenEmail('look at vocabulary.com'), null)
check('nor look at a mail host', spokenEmail('look at gmail.com'), null)
check('nor sign in at one', spokenEmail('sign in at gmail.com'), null)
check('nor two words before the at', spokenEmail('meet me at example.com'), null)
check('nor a whole sentence', spokenEmail('can you look at vocabulary dot com for me'), null)
check('nor a local part with no mailbox host', spokenEmail('tickets at vocabulary.com'), null)
check('a path after the host is not an address', spokenEmail('zechariah at gmail.com slash inbox'), null)

/* ---------------------------------------------------------- the mechanism */

check('masking leaves no address in the text', maskUrls('go to vocabulary.com/join/123456').urls, [
  'vocabulary.com/join/123456'
])
check(
  'and restoring puts it back exactly',
  (() => {
    const m = maskUrls('go to vocabulary.com/join/123456 now')
    return restoreUrls(m.text, m.urls)
  })(),
  'go to vocabulary.com/join/123456 now'
)
check('two addresses in one line', urlsIn('open example.com and vocabulary.com/join/123456'), [
  'example.com',
  'vocabulary.com/join/123456'
])
check('a placeholder nothing claimed never shows', restoreUrls(`a${String.fromCharCode(0xe000)}9${String.fromCharCode(0xe000)}b`, []), 'a9b')
check('tidyUrls is mask and restore', tidyUrls('go to vocabulary dot com'), 'go to vocabulary.com')

/*
 * The vocabulary table must not reach inside an address. /json was being
 * shouted into /JSON and "github dot com" into "GitHub dot com", which is what
 * the ordering in tidyTranscript exists to prevent.
 */
check(
  'the vocabulary table cannot reach inside',
  tidy('open example.com slash json slash python'),
  'Open example.com/json/python'
)
check(
  'but still fires outside one',
  tidy('open example.com and then use power shell'),
  'Open example.com and then use PowerShell'
)

/* -------------------------------------------------------- the polish guard */

const spoken = 'go to vocabulary.com/join/123456'
check('polish may punctuate around an address', polishAcceptable(spoken, 'Go to vocabulary.com/join/123456.'), true)
check(
  'but not change the code',
  polishAcceptable(spoken, 'Go to vocabulary.com/join/12345.'),
  false
)
check('nor the host', polishAcceptable(spoken, 'Go to vocabulary.co/join/123456.'), false)
check('nor drop the address', polishAcceptable(spoken, 'Go to the join page.'), false)

/* ------------------------------------------------------------- the wiring */

const dictation = readFileSync('src/shared/dictation.ts', 'utf8')
check('addresses are masked before the tables', /maskUrls\(text\)/.test(dictation), true)
check('and restored after them', /restoreUrls\(text, addresses\.urls\)/.test(dictation), true)
check(
  'masking happens before the extensions pass',
  dictation.indexOf('maskUrls(text)') < dictation.indexOf('for (const { from, to } of EXTENSIONS)'),
  true
)
check('the polish guard compares addresses', /urlsIn\(raw\)/.test(dictation), true)

const worker = readFileSync('resources/speech/worker.py', 'utf8')
check('Whisper is told what a URL looks like', /https:\/\//.test(worker), true)
check('and that a code is digits, not dashes', /123456/.test(worker), true)

console.log(`${NL}${count - failed}/${count} spoken-address checks passed`)
if (failed) process.exit(1)

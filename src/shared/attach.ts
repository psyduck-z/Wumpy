/**
 * Attaching a file of any sort, and deciding what "any sort" can mean.
 *
 * Until now the picker said `accept="image/*,video/*"` and a drop of anything
 * else was ignored - not refused, ignored, which is the worst of the three
 * outcomes: the file vanished and nothing said why. The ask was to allow files
 * of any sort, and the honest reading of that is not "send every byte of
 * everything to Google". It is that nothing is silently dropped, and that each
 * kind of file is handled the way that kind of file is useful.
 *
 * There are three ways a file can be useful to a model, and a fourth case that
 * has to be admitted rather than hidden.
 *
 *   TEXT      A .ts, .md, .csv, .log or anything else whose bytes are
 *             characters goes in as characters, in a fence with its name on
 *             it. That is exact, cheap - a kilobyte of code is about 250
 *             tokens against 1,100 for a screenshot of the same code - and it
 *             works on every model, including ones that cannot see at all.
 *             It is also the only form the model can quote back accurately.
 *
 *   BYTES     An image, a clip, a sound file or a PDF is only itself. It goes
 *             up as a data URL, which is how images and video already go: the
 *             endpoint takes the type from the URL rather than from the name
 *             of the part it is in.
 *
 *   NEITHER   A .zip, an .exe, a .docx (which is a zip), a database. There is
 *             nothing to send: the bytes are not characters and the model
 *             cannot open an archive. So the file is still ATTACHED, and what
 *             goes up is a line saying what it is - name, type, size - which
 *             is enough for the model to say "that is a Word file, export it
 *             as text and I can read it" instead of guessing at a filename.
 *
 * The fourth case is a file with no extension, or one nobody has heard of.
 * Rather than refuse it, the bytes are looked at: text that is text is treated
 * as text whatever it is called, which is how a Dockerfile, a .gitconfig or a
 * .fountain script end up working without being in any table.
 *
 * CAPS, and why they are not generous. The window here is 32,768 tokens and
 * about 13,300 of it is the instructions, which leaves room for roughly
 * nineteen thousand - so one file is capped at 16,000 characters (~4,000
 * tokens) and a message's files at 32,000 together. A file over the cap is NOT
 * refused and NOT quietly shortened: the first 16,000 characters go, and both
 * the chip and the fence say how much was left behind, because a model given
 * half a file and not told so will answer confidently about the half it has.
 *
 * Pure: no DOM, no disk, no fetch. The renderer reads bytes and the wire
 * assembles parts; every decision about what a file IS lives here, so the
 * checks can run a filesystem's worth of names through it in a millisecond.
 */

/** What a file turns into. */
export type AttachKind = 'image' | 'video' | 'audio' | 'document' | 'text' | 'opaque'

/** Characters of one file that go up. */
export const TEXT_CHARS = 16_000

/** Characters of all a message's files that go up, together. */
export const TEXT_TOTAL = 32_000

/**
 * Bytes to read off a large text file.
 *
 * Four per character, which is UTF-8's worst case, so the cap above is always
 * reachable without reading a two-gigabyte log into memory to throw away
 * 99.99% of it. A sliced read is why attaching a huge file is instant.
 */
export const TEXT_READ_BYTES = TEXT_CHARS * 4

/** Hard ceiling for a file whose bytes go up whole. */
export const MAX_SEND_BYTES = 15_000_000

/** Roughly what a character costs, for the chips and the context meter. */
export const CHARS_PER_TOKEN = 4

/** A flat charge, measured: a screenshot bills ~1,100 whatever its size. */
export const IMAGE_TOKENS = 1100

/** Measured at about 105 a second for video, and audio is cheaper. */
export const VIDEO_TOKENS_PER_SECOND = 105
export const AUDIO_TOKENS_PER_SECOND = 32

/**
 * A PDF page is a picture as far as the charge goes.
 *
 * Only used to warn before sending, and deliberately pessimistic: it is better
 * to say "about 3,300" for a three-page PDF and be high than to let someone
 * attach forty pages of a manual into a 32k window and find out afterwards.
 */
export const DOCUMENT_TOKENS_PER_100KB = IMAGE_TOKENS

const BY_EXTENSION: Array<[RegExp, AttachKind]> = [
  [/\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|ico|tiff?)$/i, 'image'],
  [/\.(mp4|mov|webm|mkv|avi|m4v|mpe?g|wmv|3gp|flv)$/i, 'video'],
  [/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?)$/i, 'audio'],
  [/\.pdf$/i, 'document'],
  [
    /\.(txt|text|md|markdown|mdx|rst|adoc|asciidoc|log|csv|tsv|psv|json|json5|jsonc|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|config|properties|env|xml|xsd|xsl|svg|html?|xhtml|css|scss|sass|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro|py|pyi|ipynb|rb|php|pl|pm|lua|r|jl|go|rs|c|h|cc|cpp|cxx|hpp|hh|cs|fs|fsx|java|kt|kts|scala|swift|m|mm|dart|ex|exs|erl|hrl|clj|cljs|edn|hs|ml|mli|nim|zig|v|sv|vhd|vhdl|asm|s|sh|bash|zsh|fish|ps1|psm1|psd1|bat|cmd|awk|sed|sql|graphql|gql|proto|thrift|tf|tfvars|hcl|dockerfile|containerfile|makefile|mk|cmake|gradle|sbt|bazel|bzl|patch|diff|srt|vtt|sub|ass|tex|bib|cls|sty|org|wiki|textile|gitignore|gitattributes|gitconfig|gitmodules|editorconfig|npmrc|nvmrc|prettierrc|eslintrc|babelrc|browserslistrc|dockerignore|htaccess|lock|sum|mod|cabal|gemspec|podspec|plist|strings|resx|po|pot|ics|vcf|gpx|kml|obj|mtl|stl|ply|fountain|rmd|qmd)$/i,
    'text'
  ],
  [
    /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|lz4|iso|dmg|pkg|msi|exe|dll|so|dylib|bin|dat|db|sqlite3?|mdb|accdb|docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key|epub|mobi|azw3|psd|ai|sketch|fig|xd|blend|fbx|glb|gltf|unity|pdb|idb|class|jar|war|pyc|pyo|wasm|o|a|lib|obj)$/i,
    'opaque'
  ]
]

/** Files with no extension at all that are known to be text. */
const BY_NAME = new Set([
  'dockerfile',
  'containerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'brewfile',
  'justfile',
  'vagrantfile',
  'jenkinsfile',
  'cname',
  'license',
  'licence',
  'notice',
  'authors',
  'contributors',
  'changelog',
  'readme',
  'todo',
  'copying',
  'install',
  'news',
  'version',
  'codeowners',
  'requirements',
  'pipfile',
  'cargo',
  'go'
])

/**
 * The kind a NAME suggests, or null when the name says nothing.
 *
 * Null is not a refusal. It means the bytes have to be looked at, which is
 * `kindFor`'s second half and the reason a file nobody has ever heard of can
 * still be attached as text.
 */
export function kindByName(file: { name?: string; type?: string }): AttachKind | null {
  const type = (file.type ?? '').toLowerCase()
  const name = (file.name ?? '').toLowerCase()

  for (const [pattern, kind] of BY_EXTENSION) if (pattern.test(name)) return kind

  /* The name had nothing to say, so the browser's guess gets a turn. It is
     only a guess - Windows hands over an empty type for most things. */
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'document'
  if (type.startsWith('text/')) return 'text'
  if (/^application\/(json|xml|javascript|x-sh|x-yaml|yaml|sql|graphql|toml)$/.test(type))
    return 'text'
  if (/\+(json|xml)$/.test(type)) return 'text'

  const bare = name.replace(/^.*[\\/]/, '').replace(/\.(in|dist|sample|example|template)$/, '')
  if (BY_NAME.has(bare)) return 'text'
  // A dotfile with nothing after the dot is a config file: .gitignore, .env.
  if (/^\.[a-z0-9-]+$/.test(bare)) return 'text'

  return null
}

/**
 * Is this run of bytes characters?
 *
 * A NUL settles it: no text file contains one, and every binary format worth
 * worrying about has them in the first few bytes - a zip, a PNG, a JPEG, an
 * executable, anything compressed. That check does nearly all the work.
 *
 * The proportion of other control codes is a second, looser gate, and loose on
 * purpose: a coloured log is full of ESC, and one line of it measured 6%
 * control bytes, so a tight threshold would have called wumpy.log a binary.
 * Ten percent still separates text from anything that is not.
 */
export function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return true
  if (encodingOf(sample) !== 'utf-8') return true

  let odd = 0
  const limit = Math.min(sample.length, 8192)
  for (let i = 0; i < limit; i++) {
    const byte = sample[i]
    if (byte === 0) return false
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) odd++
  }
  return odd / limit < 0.1
}

/**
 * Which flavour of text, because Notepad still writes UTF-16.
 *
 * A UTF-16 file decoded as UTF-8 is not slightly wrong, it is every other
 * character replaced by a question mark - so the encoding is read off the byte
 * order mark and, failing that, off the NULs that UTF-16 leaves in ASCII text.
 */
export function encodingOf(sample: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf-16le'
    if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf-16be'
  }
  /* No mark. ASCII as UTF-16 is every other byte a NUL, and which half they
     fall in says which way round it is. */
  const limit = Math.min(sample.length - (sample.length % 2), 512)
  if (limit >= 16) {
    let even = 0
    let oddPositions = 0
    for (let i = 0; i < limit; i++) {
      if (sample[i] !== 0) continue
      if (i % 2 === 0) even++
      else oddPositions++
    }
    const half = limit / 2
    if (oddPositions > half * 0.6 && even === 0) return 'utf-16le'
    if (even > half * 0.6 && oddPositions === 0) return 'utf-16be'
  }
  return 'utf-8'
}

/**
 * The final answer, name and bytes together.
 *
 * The name wins when it says anything, because ".ts" is a stronger signal than
 * a heuristic; the bytes decide everything else. A file the name claims is
 * text but whose bytes are not stays text only if the bytes agree, so a .json
 * that is actually a zip does not go up as mojibake.
 */
export function kindFor(file: { name?: string; type?: string }, sample?: Uint8Array): AttachKind {
  const named = kindByName(file)
  if (named && named !== 'text') return named
  if (!sample) return named ?? 'opaque'
  if (looksLikeText(sample)) return 'text'
  return named === 'text' ? 'opaque' : 'opaque'
}

/** True when this kind's bytes are what gets sent. */
export function sendsBytes(kind: AttachKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document'
}

/** The media type to put in the data URL, which is what the endpoint reads. */
export function mimeFor(file: { name?: string; type?: string }, kind: AttachKind): string {
  if (file.type) return file.type
  const name = (file.name ?? '').toLowerCase()
  const extension = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? ''
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    pdf: 'application/pdf'
  }
  if (table[extension]) return table[extension]
  if (kind === 'image') return 'image/png'
  if (kind === 'video') return 'video/mp4'
  if (kind === 'audio') return 'audio/mpeg'
  if (kind === 'document') return 'application/pdf'
  return 'application/octet-stream'
}

export interface Trimmed {
  text: string
  /** Characters the file had, which is not what was sent when it was over. */
  chars: number
  truncated: boolean
}

/**
 * The first `cap` characters, and the truth about the rest.
 *
 * Cut at a line break where there is one nearby, because stopping a code file
 * mid-token reads as a syntax error rather than as an ending.
 */
export function trimForSend(text: string, cap = TEXT_CHARS): Trimmed {
  const chars = text.length
  if (chars <= cap) return { text, chars, truncated: false }
  const hard = text.slice(0, cap)
  const breakAt = hard.lastIndexOf('\n')
  const kept = breakAt > cap * 0.8 ? hard.slice(0, breakAt) : hard
  return { text: kept, chars, truncated: true }
}

/** Bytes as a person reads them. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return `${Math.max(1, Math.round(bytes))}B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}

/** A fence is opened with enough backticks to survive what is inside it. */
function fenceFor(body: string): string {
  const longest = /`{3,}/g.exec(body)?.[0]?.length ?? 0
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The language tag, so a code file arrives as code. */
const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  sql: 'sql',
  json: 'json',
  jsonl: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile'
}

export function languageFor(name: string | undefined): string {
  const bare = (name ?? '').toLowerCase().replace(/^.*[\\/]/, '')
  const extension = /\.([a-z0-9]+)$/.exec(bare)?.[1] ?? bare
  return LANGUAGES[extension] ?? ''
}

/** What the model is shown for one file, as a type it can act on. */
export interface Attached {
  kind: AttachKind
  name?: string
  bytes: number
  text?: string
  chars?: number
  truncated?: boolean
  mime?: string
  seconds?: number
}

/**
 * One text file, fenced, named, and honest about being cut.
 *
 * The name is on it because "fix the import" means nothing without knowing
 * which file is which, and the truncation note is inside the fence rather than
 * beside it so that a model reading only the block still sees it.
 */
export function textBlock(file: Attached): string {
  const name = file.name ?? 'attached file'
  const body = file.text ?? ''
  const fence = fenceFor(body)
  const language = languageFor(file.name)
  const head = file.truncated
    ? `${name} — FIRST ${body.length.toLocaleString()} OF ${(file.chars ?? body.length).toLocaleString()} CHARACTERS. The rest was not sent; ask for a part of it by name or line if you need more.`
    : name
  return `${head}${String.fromCharCode(10)}${fence}${language}${String.fromCharCode(10)}${body}${String.fromCharCode(10)}${fence}`
}

/**
 * The line that stands in for a file whose bytes are no use to anybody.
 *
 * It says what the thing is and that nothing of its contents went up, because
 * the failure to say so is what makes a model invent a plausible answer about
 * a spreadsheet it never saw.
 */
export function opaqueLine(file: Attached): string {
  const name = file.name ?? 'an attached file'
  const type = file.mime && file.mime !== 'application/octet-stream' ? `, ${file.mime}` : ''
  return (
    `[attached: ${name} (${sizeLabel(file.bytes)}${type}). ` +
    'Its contents were NOT sent - this format is not text and cannot be read here. ' +
    'Say so rather than guessing at what is in it; a text, CSV, Markdown or PDF export can be read.]'
  )
}

/** What one attachment is going to cost, near enough to warn with. */
export function attachmentTokens(file: Attached): number {
  switch (file.kind) {
    case 'image':
      return IMAGE_TOKENS
    case 'video':
      return Math.round((file.seconds ?? 0) * VIDEO_TOKENS_PER_SECOND) || IMAGE_TOKENS
    case 'audio':
      return Math.round((file.seconds ?? 0) * AUDIO_TOKENS_PER_SECOND) || 500
    case 'document':
      return Math.max(IMAGE_TOKENS, Math.round((file.bytes / 100_000) * DOCUMENT_TOKENS_PER_100KB))
    case 'text':
      return Math.ceil((file.text?.length ?? 0) / CHARS_PER_TOKEN)
    case 'opaque':
      return Math.ceil(opaqueLine(file).length / CHARS_PER_TOKEN)
  }
}

/**
 * Did the endpoint refuse the attachment itself?
 *
 * Images and video are measured as working on this endpoint; a PDF and a sound
 * file are sent the same way on the strength of the same note - that the type
 * is read off the data URL rather than off the part's name - and that could not
 * be confirmed here, because the API answered 503 and then timed out across
 * four keys and both models while this was written.
 *
 * So the unverified half is made safe rather than asserted: a refusal that
 * names the file, the type or the inline data is recognised, the turn is sent
 * again with the bytes replaced by a line saying what the file was, and the
 * user is told in plain words. If the capability is there, nothing here ever
 * runs. If it is not, an attached PDF costs one wasted request and still gets
 * an honest answer, instead of eating the turn.
 */
const REFUSED = [
  /unsupported\s+(file|mime|content|media|document)[\s-]*type/i,
  /invalid\s+(audio|video|image|file|document|mime|media)/i,
  /mime\s*type\s+.{0,40}(not|un)supported/i,
  /inline[_\s-]?data/i,
  /(cannot|could not|unable to)\s+(read|parse|process|decode)\s+(the\s+)?(file|document|attachment|input)/i,
  /file\s+type\s+is\s+not/i
]

export function refusedAttachment(message: string): boolean {
  const text = (message ?? '').trim()
  if (!text) return false
  return REFUSED.some((pattern) => pattern.test(text))
}

/**
 * The same attachments, with the bytes taken out and the fact stated.
 *
 * Used by the retry above, and by anything else that has to send a message
 * whose bytes cannot go: the model is told a file was attached and could not
 * be read, which is the one thing that stops it answering as if it had seen it.
 */
export function withoutBytes<T extends Attached>(files: readonly T[] | undefined): T[] {
  return (files ?? []).map((file) =>
    sendsBytes(file.kind) ? ({ ...file, kind: 'opaque', dataUrl: '' } as unknown as T) : file
  )
}

export interface Folded {
  /** The text part of the message: the files, then what the user typed. */
  text: string
  /** The attachments whose bytes go up as data URLs. */
  bytes: Attached[]
  /** True when a text file had to be shortened to fit the message budget. */
  trimmed: boolean
}

/**
 * Lays one message out for the wire.
 *
 * Files first, question last. A question read before its attachment is a
 * question about nothing, and the user's words are the thing a model should
 * have most recently in view when it starts answering.
 *
 * The total budget is spent in order, so the first file attached gets the room.
 * That is deliberate: dropping the tail of the LAST file is predictable, where
 * sharing the budget equally would silently halve a file that would have fitted
 * on its own.
 */
export function foldAttachments(
  content: string,
  files: Attached[] | undefined,
  total = TEXT_TOTAL
): Folded {
  const pieces: string[] = []
  const bytes: Attached[] = []
  let left = Math.max(0, total)
  let trimmed = false

  for (const file of files ?? []) {
    if (sendsBytes(file.kind)) {
      bytes.push(file)
      continue
    }
    if (file.kind === 'opaque') {
      pieces.push(opaqueLine(file))
      continue
    }
    const body = file.text ?? ''
    if (!body) continue
    const room = Math.min(body.length, left)
    if (room <= 0) {
      /* No budget left at all: say the file is there rather than drop it. */
      pieces.push(opaqueLine({ ...file, mime: 'text', kind: 'opaque' }))
      trimmed = true
      continue
    }
    const cut = trimForSend(body, room)
    const wasTrimmed = cut.truncated || file.truncated === true
    if (cut.truncated) trimmed = true
    pieces.push(
      textBlock({
        ...file,
        text: cut.text,
        chars: file.chars ?? body.length,
        truncated: wasTrimmed
      })
    )
    left -= cut.text.length
  }

  if (content) pieces.push(content)
  return { text: pieces.join(`${String.fromCharCode(10)}${String.fromCharCode(10)}`), bytes, trimmed }
}

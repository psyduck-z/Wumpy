import { memo, useState, isValidElement, type ReactNode } from 'react'
import { copyText } from '../copy'
import type {
  Attachment,
  DesktopResult,
  LinkResult,
  SearchResult,
  ShellKind,
  ShellResult,
  WriteResult,
  WriteTarget
} from '@shared/types'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { normaliseFences } from '@shared/fences'
import { foldsCode, summarise } from '@shared/bulk'
import { CommandCard } from './CommandCard'
import { AskCard } from './AskCard'
import { SearchCard } from './SearchCard'
import { ScreenCard } from './ScreenCard'
import { DoCard } from './DoCard'
import { LinkCard } from './LinkCard'
import { WriteCard } from './WriteCard'
import type { LinkApproval } from '@shared/links'

/**
 * Reads the text out of a rendered code block, for measuring it.
 *
 * react-markdown has already turned the fence into elements, so the source is
 * only reachable through the child nodes.
 */
function codeTextOf(children: ReactNode): string {
  if (!isValidElement(children)) return ''
  const props = children.props as { children?: unknown }
  if (typeof props.children === 'string') return props.children
  if (Array.isArray(props.children)) {
    return props.children.filter((c) => typeof c === 'string').join('')
  }
  return ''
}

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  /**
   * A whole program in a 460px panel buries the sentence explaining it.
   *
   * Folded by default past the threshold in bulk.ts, with the size on the
   * fold so the user knows what they are opening. Collapsed rather than
   * truncated: the text is all still there, and Copy still copies the lot
   * whether it is open or not, because it reads the DOM beneath.
   */
  const source = codeTextOf(children)
  const long = foldsCode(source)
  const [open, setOpen] = useState(false)

  const copy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const code = e.currentTarget.parentElement?.querySelector('code')
    if (!code?.textContent) return
    /* Main process, not the page: writeText needs document focus and this
       window often does not have it. */
    void copyText(code.textContent).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className={`codeblock ${long && !open ? 'is-folded' : ''}`}>
      <button className="copy" onClick={copy} type="button">
        {copied ? 'Copied' : 'Copy'}
      </button>
      {long && (
        <button className="fold" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : `Show (${summarise(source)})`}
        </button>
      )}
      {/* Kept mounted while folded, so Copy still finds the code. */}
      <pre hidden={long && !open}>{children}</pre>
    </div>
  )
}

/**
 * Reads a `wumpy-ask` block: one or more questions, each followed by its
 * options on `-` lines.
 *
 * It used to be a single question, because a small local model that asked two
 * things at once usually meant one. On a capable model that limit is just a
 * worse conversation: "not installed, want the website?" and "shall I also
 * check for an update?" are two clicks' worth of decision and three turns'
 * worth of round trips.
 *
 * A line with no leading dash starts a new question and claims every option
 * under it. Capped at four questions, because a form longer than that is not
 * a question any more, and at five options each.
 */
export interface AskGroup {
  question: string
  options: string[]
}

export function readAskGroups(raw: string): AskGroup[] {
  const groups: AskGroup[] = []
  for (const line of raw.split(String.fromCharCode(10)).map((l) => l.trim())) {
    if (!line) continue
    if (line.startsWith('-')) {
      const option = line.replace(/^-\s*/, '').trim()
      // An option before any question belongs to nothing; dropping it is
      // better than inventing a question to hang it on.
      if (option && groups.length) groups[groups.length - 1].options.push(option)
      continue
    }
    if (groups.length >= 4) break
    groups.push({ question: line, options: [] })
  }
  // A question with fewer than two options is prose, not a choice.
  return groups
    .filter((g) => g.options.length >= 2)
    .map((g) => ({
      question: g.question,
      options: g.options.slice(0, 5)
    }))
}

function readAsk(children: ReactNode): AskGroup[] | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: unknown; children?: unknown }
  if (typeof props.className !== 'string') return null
  if (!props.className.split(/\s+/).includes('language-wumpy-ask')) return null

  const raw =
    typeof props.children === 'string'
      ? props.children
      : Array.isArray(props.children)
        ? props.children.filter((c) => typeof c === 'string').join('')
        : ''

  const groups = readAskGroups(raw)
  return groups.length ? groups : null
}

/**
 * Pulls the text back out of a rendered fence with a given tag.
 *
 * react-markdown has already turned the fence into <pre><code class="language-x">
 * by the time a custom renderer sees it, so the tag and the source have to be
 * read back off the element rather than matched in the markdown.
 */
function readTagged(children: ReactNode, tag: string): string | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: unknown; children?: unknown }
  if (typeof props.className !== 'string') return null
  if (!props.className.split(/\s+/).includes(tag)) return null
  const raw =
    typeof props.children === 'string'
      ? props.children
      : Array.isArray(props.children)
        ? props.children.filter((c) => typeof c === 'string').join('')
        : ''
  return raw.trim() || null
}

/** Pulls the body out of a `wumpy-write` block. */
function readWrite(children: ReactNode): string | null {
  return readTagged(children, 'language-wumpy-write')
}

/** Pulls the body out of a `wumpy-open` block. */
function readOpen(children: ReactNode): string | null {
  return readTagged(children, 'language-wumpy-open')
}

/**
 * A `wumpy-screen` block, which asks to look at the screen.
 *
 * Unlike the others this one carries no payload - there is nothing to run,
 * only a reason - so an empty body still counts as a request. readTagged
 * returns null for an empty fence, hence the explicit check on the tag.
 */
function readScreen(children: ReactNode): string | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: unknown }
  if (typeof props.className !== 'string') return null
  if (!props.className.split(/\s+/).includes('language-wumpy-screen')) return null
  return readTagged(children, 'language-wumpy-screen') ?? ''
}

/** Pulls the steps out of a `wumpy-do` block. */
function readDo(children: ReactNode): string | null {
  return readTagged(children, 'language-wumpy-do')
}

/** Pulls the query out of a `wumpy-search` block. */
function readSearch(children: ReactNode): string | null {
  return readTagged(children, 'language-wumpy-search')
}

/**
 * The last sentence of prose before the first fence.
 *
 * Models reliably say what they are about to do and then sometimes omit the
 * `# why` line inside the block. Rather than show "No reason given" in red when
 * the reason is sitting right above it, the card falls back to this.
 */
function leadIn(markdown: string): string | null {
  const before = markdown.split('```')[0].trim()
  if (!before) return null
  const sentence = before
    .split(/\n{2,}/)
    .pop()
    ?.replace(/\s+/g, ' ')
    .trim()
  if (!sentence || sentence.length > 160) return null
  return sentence
}

/**
 * The contents of a fence that has been opened and not yet closed, or null.
 *
 * Markdown renders an unterminated fence as a code block, so a card exists from
 * the moment ``` is revealed and its contents grow a character at a time. Every
 * one of those prefixes is a different string, so de-duplicating commands does
 * not help; a block nobody has finished writing is not a proposal yet.
 *
 * Only the last fence can be open, so this names the one block that is still
 * being written — and by elimination says every other block is final, even
 * while the model carries on typing after it. That matters on this hardware:
 * waiting for the whole answer before offering Run costs however long the model
 * spends on the sentence that follows the command.
 */
function openFenceBody(text: string): string | null {
  const lines = text.split('\n')
  let opensAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) opensAt = opensAt === -1 ? i : -1
  }
  if (opensAt === -1) return null
  return lines
    .slice(opensAt + 1)
    .join('\n')
    .trim()
}

/**
 * Only the first runnable block in a reply stays runnable.
 *
 * The contract has always been one command per turn - the prompt says
 * "propose ONE command" - but nothing enforced it, and the model does not
 * always comply. Measured: asked "my firewall is off, turn it back on", it
 * produced two blocks, a Get-NetFirewallProfile check AND a
 * Set-NetFirewallProfile that turns it on. Both rendered as cards, so the
 * user was handed a live button to change a security setting beside the
 * button that would have told them whether it needed changing.
 *
 * Asking the model again was not the fix. The later blocks are retagged so
 * they render as ordinary code: still visible, still readable, no longer
 * one click from running. The model gets its plan across and the user gets
 * one decision at a time.
 *
 * Pure, and separate from the component, so the rule can be tested without
 * rendering anything.
 */
export function keepFirstRunnable(text: string): string {
  const FENCE = /^(\s*```)(wumpy-run(?:-cmd|-bash)?)(\s*)$/
  let seen = false
  return text
    .split(String.fromCharCode(10))
    .map((line) => {
      const m = FENCE.exec(line)
      if (!m) return line
      if (!seen) {
        seen = true
        return line
      }
      // A tag the fence reader does not recognise, so it renders as code.
      return `${m[1]}powershell${m[3]}`
    })
    .join(String.fromCharCode(10))
}

/** Maps a fence tag to the shell it should run in, or null for ordinary code. */
function runnableShell(className: unknown): ShellKind | null {
  if (typeof className !== 'string') return null
  // Exact tag match on the class list, so language-wumpy-runner is not runnable.
  const tags = className.split(/\s+/)
  if (tags.includes('language-wumpy-run-cmd')) return 'cmd'
  if (tags.includes('language-wumpy-run-bash')) return 'bash'
  if (tags.includes('language-wumpy-run')) return 'powershell'
  return null
}

/** Pulls the fence tag and source text back out of a rendered <pre>. */
function readFence(children: ReactNode): { shell: ShellKind; code: string } | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: unknown; children?: unknown }
  const shell = runnableShell(props.className)
  if (!shell) return null

  const code =
    typeof props.children === 'string'
      ? props.children
      : Array.isArray(props.children)
        ? props.children.filter((c) => typeof c === 'string').join('')
        : ''
  const trimmed = code.trim()
  return trimmed ? { shell, code: trimmed } : null
}

export interface MarkdownProps {
  text: string
  /** Supplied for assistant turns that may ask the user a question. */
  onAnswer?: (option: string) => void
  /** The option already chosen for this message's question, if any. */
  answered?: string | null
  /** Supplied for assistant turns that may propose commands. */
  onRunCommand?: (command: string, shell: ShellKind) => Promise<ShellResult | null>
  /** False while the message is still arriving, so half-written commands wait. */
  complete?: boolean
  /** Whether a given command may still run unattended. */
  canAutoRun?: (command: string, messageId: string) => boolean
  /** Which message this is, so one message can only run one command. */
  messageId?: string
  /** Supplied for assistant turns that may search the web. */
  onSearch?: (query: string) => Promise<{
    results: SearchResult[]
    provider: string
    error?: string
  }>
  onSearchResults?: (
    query: string,
    results: SearchResult[],
    provider: string,
    error?: string
  ) => void
  onCommandResult?: (result: ShellResult, unattended: boolean) => void
  /** Supplied for assistant turns that may create files. */
  onWriteFile?: (path: string, content: string) => Promise<WriteResult>
  onCheckWrite?: (path: string) => Promise<WriteTarget>
  onWritten?: (result: WriteResult, messageId: string) => void
  /** True when accept-all is on, so a file may be written without a click. */
  autoWrite?: boolean
  /** Supplied for assistant turns that may open a page in the browser. */
  /** Takes the picture. Absent when screen capture is turned off. */
  onCaptureScreen?: () => Promise<Attachment>
  /** Hands the picture to the conversation. */
  onScreenCaptured?: (shot: Attachment) => void
  /** Runs an approved plan of clicks and keystrokes. Absent when off. */
  onDesktop?: (body: string) => Promise<DesktopResult>
  /** Hands the outcome, and the screen afterwards, to the conversation. */
  onDesktopDone?: (result: DesktopResult, after: Attachment | null) => void
  onOpenLink?: (url: string) => Promise<LinkResult>
  onOpenSearch?: (query: string) => Promise<LinkResult>
  onOpened?: (result: LinkResult, messageId: string) => void
  /** How much may happen without a click, and where searches go. */
  linkMode?: LinkApproval
  searchEngine?: string
  /**
   * Whether this model writes a plain shell fence where Wumpy asks for
   * ```wumpy-run. Declared per model in CLOUD_MODELS; see normaliseFences.
   */
  looseFences?: boolean
}

/**
 * Memoised because streaming re-renders the message on every token, and
 * re-parsing markdown each time is the one thing that makes the panel feel slow.
 *
 * Note: `rehype-highlight` statically imports lowlight's `common` language set,
 * so passing an explicit `languages` list adds to the bundle rather than
 * trimming it. The default is the smaller option.
 *
 * `detect` is off because it is the single most expensive thing the panel did.
 * With it on, every untagged block is guessed at by trying each language in
 * that set, and the guess is repeated on every re-parse. Measured on a typical
 * 618-character answer: 40.94ms per parse with detection, 5.25ms without, and
 * 2.40ms with no highlighting at all. Streamed in, that is 1202ms of CPU spent
 * per answer against 366ms — all of it while the model is generating, which is
 * exactly when the cores are wanted elsewhere. What it buys is colour on blocks
 * the model forgot to tag, and the model is told to tag them.
 */
/**
 * The plugin lists, built once rather than per render.
 *
 * Highlighting waits for the end of the answer. The whole message is parsed
 * again on every commit of the reveal — about thirty a second — and
 * rehype-highlight re-tokenises every code block in it each time: measured
 * at 0.45ms a commit on a 4,000-character answer and 0.76ms at 8,000, which
 * is 14 to 23ms of every second spent colouring text that is still being
 * written. The colours also churn while it writes, because a half-finished
 * line lexes differently from the finished one.
 *
 * Nothing is lost by waiting: `complete` is true for every message in the
 * history, so the only thing that goes unhighlighted is the few seconds an
 * answer is arriving, and it is highlighted once when it lands.
 */
const REMARK: Options['remarkPlugins'] = [remarkGfm]
const HIGHLIGHT: Options['rehypePlugins'] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
const NO_HIGHLIGHT: Options['rehypePlugins'] = []

export const Markdown = memo(function Markdown({
  text,
  onRunCommand,
  onCommandResult,
  onAnswer,
  answered = null,
  complete = true,
  canAutoRun,
  messageId,
  onSearch,
  onSearchResults,
  onWriteFile,
  onCheckWrite,
  onWritten,
  autoWrite = false,
  onCaptureScreen,
  onDesktop,
  onDesktopDone,
  onScreenCaptured,
  onOpenLink,
  onOpenSearch,
  onOpened,
  linkMode = 'manual',
  searchEngine = 'duckduckgo',
  looseFences = false
}: MarkdownProps) {
  // The one block still being written, if any. Everything else is final, even
  // mid-answer, so a command can be offered the moment its fence closes rather
  // than when the model finally stops talking about it.
  const pending = openFenceBody(text)
  const settled = (code: string): boolean => complete || pending === null || code !== pending
  return (
    <ReactMarkdown
      remarkPlugins={REMARK}
      rehypePlugins={complete ? HIGHLIGHT : NO_HIGHLIGHT}
      components={{
        pre: ({ children }) => {
          const file = onWriteFile ? readWrite(children) : null
          if (file) {
            return (
              <WriteCard
                request={file}
                complete={settled(file)}
                autoWrite={autoWrite}
                onCheck={onCheckWrite!}
                onWrite={onWriteFile!}
                onWritten={onWritten ?? (() => {})}
                messageId={messageId ?? ''}
              />
            )
          }

          const link = onOpenLink ? readOpen(children) : null
          if (link) {
            return (
              <LinkCard
                request={link}
                complete={settled(link)}
                mode={linkMode}
                engine={searchEngine}
                onOpen={onOpenLink!}
                onSearch={
                  onOpenSearch ?? (async () => ({ opened: false, url: '', host: '', error: 'off' }))
                }
                onOpened={onOpened ?? (() => {})}
                messageId={messageId ?? ''}
              />
            )
          }

          const screen = onCaptureScreen ? readScreen(children) : null
          if (screen !== null) {
            return (
              <ScreenCard
                body={screen}
                complete={settled(screen)}
                mode={linkMode}
                messageId={messageId ?? ''}
                fallbackReason={leadIn(text)}
                onCapture={onCaptureScreen!}
                onCaptured={onScreenCaptured ?? (() => {})}
              />
            )
          }

          const plan = onDesktop ? readDo(children) : null
          if (plan) {
            return (
              <DoCard
                body={plan}
                complete={settled(plan)}
                mode={linkMode}
                messageId={messageId ?? ''}
                fallbackReason={leadIn(text)}
                onRun={onDesktop!}
                onDone={onDesktopDone ?? (() => {})}
              />
            )
          }

          const query = onSearch ? readSearch(children) : null
          if (query) {
            return (
              <SearchCard
                query={query}
                complete={settled(query)}
                mode={linkMode}
                messageId={messageId}
                onSearch={onSearch!}
                onResults={onSearchResults ?? (() => {})}
              />
            )
          }

          const ask = onAnswer ? readAsk(children) : null
          if (ask) {
            return <AskCard groups={ask} answered={answered} onAnswer={onAnswer!} />
          }

          const fence = onRunCommand ? readFence(children) : null
          if (fence) {
            return (
              <CommandCard
                command={fence.code}
                shell={fence.shell}
                fallbackReason={leadIn(text)}
                complete={settled(fence.code)}
                canAutoRun={canAutoRun}
                messageId={messageId}
                onRun={onRunCommand!}
                onResult={onCommandResult ?? (() => {})}
              />
            )
          }
          return <CodeBlock>{children}</CodeBlock>
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }}
    >
      {/* Loose fences are promoted first, then the one-button rule applies
          to whatever that produced - in that order, or a promoted fence
          would be the second runnable block and get demoted again. */}
      {onRunCommand ? keepFirstRunnable(looseFences ? normaliseFences(text) : text) : text}
    </ReactMarkdown>
  )
})

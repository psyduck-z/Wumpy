import { memo, useState, isValidElement, type ReactNode } from 'react'
import type { SearchResult, ShellKind, ShellResult, TierId } from '@shared/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CommandCard } from './CommandCard'
import { AskCard } from './AskCard'
import { SearchCard } from './SearchCard'

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const code = e.currentTarget.parentElement?.querySelector('code')
    if (!code?.textContent) return
    void navigator.clipboard.writeText(code.textContent).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className="codeblock">
      <button className="copy" onClick={copy} type="button">
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

/**
 * Reads a `wumpy-ask` block: a question on the first line, then one option per
 * `-` line.
 */
function readAsk(children: ReactNode): { question: string; options: string[] } | null {
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

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const question = lines.find((l) => !l.startsWith('-')) ?? ''
  const options = lines.filter((l) => l.startsWith('-')).map((l) => l.replace(/^-\s*/, ''))
  // A question with no options is just prose; let it render as a code block.
  if (!question || options.length < 2) return null
  return { question, options: options.slice(0, 5) }
}

/** Pulls the query out of a `wumpy-search` block. */
function readSearch(children: ReactNode): string | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: unknown; children?: unknown }
  if (typeof props.className !== 'string') return null
  if (!props.className.split(/\s+/).includes('language-wumpy-search')) return null
  const raw =
    typeof props.children === 'string'
      ? props.children
      : Array.isArray(props.children)
        ? props.children.filter((c) => typeof c === 'string').join('')
        : ''
  return raw.trim() || null
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
 * Whether the text ends inside an unclosed fence.
 *
 * Markdown renders an unterminated fence as a code block, so a card exists from
 * the moment ``` is revealed and its contents grow a character at a time. Every
 * one of those prefixes is a different string, so de-duplicating commands does
 * not help; the only safe rule is that a block nobody has finished writing is
 * not a proposal yet.
 */
function endsMidFence(text: string): boolean {
  return (text.match(/^\s*```/gm) ?? []).length % 2 === 1
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

  const code = typeof props.children === 'string'
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
  /** The tier asking, which decides what it is allowed to run. */
  tier: TierId
  /** False while the message is still arriving, so half-written commands wait. */
  complete?: boolean
  /** Whether a given command may still run unattended. */
  canAutoRun?: (command: string, messageId: string) => boolean
  /** Which message this is, so one message can only run one command. */
  messageId?: string
  /** Supplied for assistant turns that may search the web. */
  onSearch?: (query: string) => Promise<{ results: SearchResult[]; provider: string; error?: string }>
  onSearchResults?: (
    query: string,
    results: SearchResult[],
    provider: string,
    error?: string
  ) => void
  onCommandResult?: (result: ShellResult, unattended: boolean) => void
}

/**
 * Memoised because streaming re-renders the message on every token, and
 * re-parsing markdown each time is the one thing that makes the panel feel slow.
 *
 * Note: `rehype-highlight` statically imports lowlight's `common` language set,
 * so passing an explicit `languages` list adds to the bundle rather than
 * trimming it. The default is the smaller option.
 */
export const Markdown = memo(function Markdown({
  text,
  onRunCommand,
  onCommandResult,
  onAnswer,
  answered = null,
  tier,
  complete = true,
  canAutoRun,
  messageId,
  onSearch,
  onSearchResults
}: MarkdownProps) {
  // Belt and braces with the streaming flag: that says whether tokens are still
  // arriving, this says whether what arrived is a finished block. Either one
  // being wrong used to be enough to run a fragment.
  const settled = complete && !endsMidFence(text)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{
        pre: ({ children }) => {
          const query = onSearch ? readSearch(children) : null
          if (query) {
            return (
              <SearchCard
                query={query}
                complete={settled}
                onSearch={onSearch!}
                onResults={onSearchResults ?? (() => {})}
              />
            )
          }

          const ask = onAnswer ? readAsk(children) : null
          if (ask) {
            return (
              <AskCard
                question={ask.question}
                options={ask.options}
                answered={answered}
                onAnswer={onAnswer!}
              />
            )
          }

          const fence = onRunCommand ? readFence(children) : null
          if (fence) {
            return (
              <CommandCard
                command={fence.code}
                shell={fence.shell}
                tier={tier}
                fallbackReason={leadIn(text)}
                complete={settled}
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
      {text}
    </ReactMarkdown>
  )
})

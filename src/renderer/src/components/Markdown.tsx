import { memo, useState, isValidElement, type ReactNode } from 'react'
import type { ShellKind, ShellResult, TierId } from '@shared/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CommandCard } from './CommandCard'
import { AskCard } from './AskCard'

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

/** Maps a fence tag to the shell it should run in, or null for ordinary code. */
function runnableShell(className: unknown): ShellKind | null {
  if (typeof className !== 'string') return null
  if (/language-wumpy-run-cmd/.test(className)) return 'cmd'
  if (/language-wumpy-run-bash/.test(className)) return 'bash'
  if (/language-wumpy-run/.test(className)) return 'powershell'
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
  onCommandResult?: (result: ShellResult) => void
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
  tier
}: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{
        pre: ({ children }) => {
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

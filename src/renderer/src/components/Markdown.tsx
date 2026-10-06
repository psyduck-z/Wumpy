import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

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
 * Memoised because streaming re-renders the message on every token, and
 * re-parsing markdown each time is the one thing that makes the panel feel slow.
 *
 * Note: `rehype-highlight` statically imports lowlight's `common` language set,
 * so passing an explicit `languages` list adds to the bundle rather than
 * trimming it. The default is the smaller option.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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

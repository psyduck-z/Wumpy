/**
 * Which visual row the caret is on, as opposed to which line of text.
 *
 * Reported as: recall a previous message, press Up to get to its first line
 * and edit it, and instead of moving the caret the box jumps to an older
 * entry. "when you confirm that you want this... the previous message
 * history, and you try to move up to edit the first line, it switches, it
 * uses the history one and thinks you're doing that."
 *
 * The cause is that "first line" was being decided by looking for a newline
 * before the caret. That is the first LOGICAL line, and in a 440px composer
 * almost nothing is one line: a message of fifty characters already wraps
 * across three rows with no newline in it anywhere. So the caret was
 * reported as being on the first line while sitting on the third row, every
 * Up recalled, and a wrapped message could not be edited from the top at
 * all. Down had the same fault at the other end, which is why it seemed not
 * to work.
 *
 * Rows have to be measured, because only the browser knows where the text
 * wrapped. The measuring is done against a mirror of the textarea; the
 * decision made from the measurements is pure, and is what the checks test.
 */

/** Half a row of tolerance, so a rounding error is not a row boundary. */
const SLACK = 0.5

export interface RowMetrics {
  /** Distance from the top of the content to the top of the caret's row. */
  caretTop: number
  /** One row, in pixels. */
  lineHeight: number
  /** The full height of the content, all rows. */
  totalHeight: number
}

export interface RowFlags {
  first: boolean
  last: boolean
}

/**
 * Is the caret on the first or last visual row?
 *
 * Both are true for a single-row box, which is the common case and the one
 * that must stay fast: in an empty or short composer, Up recalls the last
 * message on the first press and Down comes back, with no caret movement in
 * between to spend a keystroke on.
 */
export function rowFlags({ caretTop, lineHeight, totalHeight }: RowMetrics): RowFlags {
  if (!(lineHeight > 0)) return { first: true, last: true }
  return {
    first: caretTop < lineHeight * SLACK,
    /* The caret's row starts within one row of the bottom of the content. */
    last: caretTop + lineHeight > totalHeight - lineHeight * SLACK
  }
}

/**
 * The mirror: a div that wraps text exactly as the textarea does.
 *
 * Every property that can change where a line breaks has to be copied, or
 * the mirror wraps somewhere else and the row it reports is not the row the
 * caret is on. Kept in the document rather than rebuilt per keystroke,
 * because this runs on every Up and Down.
 */
let mirror: HTMLDivElement | null = null

const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'tabSize'
] as const

export function caretRows(el: HTMLTextAreaElement): RowFlags {
  /* A selection is not a caret; leave those to the browser entirely. */
  if (el.selectionStart !== el.selectionEnd) return { first: false, last: false }

  try {
    const style = window.getComputedStyle(el)
    if (!mirror) {
      mirror = document.createElement('div')
      mirror.setAttribute('aria-hidden', 'true')
      document.body.appendChild(mirror)
    }
    const m = mirror
    m.style.cssText = ''
    m.style.position = 'absolute'
    m.style.top = '0'
    m.style.left = '-9999px'
    m.style.visibility = 'hidden'
    m.style.whiteSpace = 'pre-wrap'
    m.style.overflowWrap = style.overflowWrap || 'break-word'
    m.style.wordBreak = style.wordBreak
    for (const prop of COPIED) m.style[prop] = style[prop]
    /* The textarea's own width, not its style width, which may be auto. */
    m.style.width = `${el.clientWidth}px`

    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionStart)
    m.textContent = before
    const marker = document.createElement('span')
    /*
     * A zero-width space, so the marker occupies a position on the line the
     * caret is on. An empty span has no box and reports the wrong row at the
     * end of a wrapped line.
     */
    marker.textContent = String.fromCharCode(0x200b)
    m.appendChild(marker)
    /*
     * The rest of the text, so totalHeight is the whole content and not
     * merely everything up to the caret - otherwise the caret is always on
     * the "last" row.
     */
    m.appendChild(document.createTextNode(after.length ? after : String.fromCharCode(0x200b)))

    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16
    /*
     * Padding comes off both, or they are measured from different origins.
     *
     * offsetTop is from the mirror's border box and so includes its top
     * padding, while the height below has the padding taken out. Measured
     * on the real composer: the caret on the FIRST row reported offsetTop
     * 10 against a line height of 21.7, which only counts as the first row
     * because 10 happens to be under half of 21.7. A padding of 12px - one
     * theme tweak away - would have silently stopped Up ever reaching the
     * history, with nothing in the code looking wrong.
     */
    const padTop = parseFloat(style.paddingTop) || 0
    const padBottom = parseFloat(style.paddingBottom) || 0
    return rowFlags({
      caretTop: marker.offsetTop - padTop,
      lineHeight,
      totalHeight: m.scrollHeight - padTop - padBottom
    })
  } catch {
    /*
     * Measurement failed, so fall back to the old logical-line test rather
     * than to nothing: a slightly over-eager recall is better than arrow
     * keys that do not reach the history at all.
     */
    const NL = String.fromCharCode(10)
    return {
      first: !el.value.slice(0, el.selectionStart).includes(NL),
      last: !el.value.slice(el.selectionEnd).includes(NL)
    }
  }
}

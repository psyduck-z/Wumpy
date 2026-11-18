/**
 * What a headless browser's log says went wrong on a page. See
 * main/pagecheck.ts. Pure, so it can be checked against real log lines.
 *
 * Chromium logs every console message at INFO, errors included, as
 *   [..:INFO:CONSOLE:142] "Uncaught ReferenceError: car is not defined", source: file:///.../x.html (142)
 * so the level is no help: the message is. An uncaught exception says
 * "Uncaught"; console.error output and failed loads say "Error" or
 * "Failed". Ordinary console.log lines are left out.
 */
const LINE = /CONSOLE[^\]]*\]\s*"([\s\S]*?)",\s*source:\s*(\S*)\s*\((\d+)\)/g

export function pageErrors(log: string, max = 8): string[] {
  const out: string[] = []
  for (const m of log.matchAll(LINE)) {
    const message = m[1].trim()
    if (!/^Uncaught\b|\bError\b|\bFailed\b|is not defined|is not a function|Cannot read propert/i.test(message)) continue
    const line = Number(m[3])
    const said = `${message}${line > 0 ? ` (line ${line})` : ''}`
    if (!out.includes(said)) out.push(said)
    if (out.length >= max) break
  }
  return out
}

/** The hand-back: what Wumpy found, said to be from the app. */
export function pageErrorText(path: string, errors: readonly string[]): string {
  return [
    `Wumpy loaded ${path} out of sight to check it, and its console showed:`,
    ...errors.map((e) => `- ${e}`),
    '',
    'That is a bug in the page you wrote. Read the file, fix the cause - and anything else wrong you see on the way - and write it again. Do not tell the user it works until it loads clean. This was sent by Wumpy, not typed by the user.'
  ].join('\n')
}

/** How many times one request may be sent back for errors before a person decides. */
export const PAGE_ROUNDS = 2

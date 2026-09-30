/** Messages longer than this, or with more lines, show a summary and keep the rest in Details. */
const LONG_MESSAGE_CHARACTERS = 240
const LONG_MESSAGE_LINES = 3
const SUMMARY_CHARACTERS = 160

const exitCodeSuffix = /^([^\n]*?)\s*\(exit (?:code|status) -?\d+\)\s*:/i
const exitCodePrefix = /^exit (?:code|status) -?\d+\s*:/i

function shorten(line: string): string {
  if (line.length <= SUMMARY_CHARACTERS) return line
  const sentence = /^.*?[.!?](?=\s)/.exec(line.slice(0, SUMMARY_CHARACTERS + 1))?.[0]
  if (sentence) return sentence
  const cut = line.lastIndexOf(" ", SUMMARY_CHARACTERS)
  return `${line.slice(0, cut > 0 ? cut : SUMMARY_CHARACTERS).trimEnd()}…`
}

/**
 * Splits an error into a short summary and the full diagnostic. A backend-supplied `diagnostic`
 * (D-39) is used as is. Otherwise raw runtime output, exit codes and long multi-line messages
 * move into `details`, which always holds the complete original text so nothing is lost.
 * `summary` is null when the message has nothing but command output.
 */
export function splitErrorDetails(message: string, diagnostic?: string | null): { summary: string | null; details: string | null } {
  const text = message.trim()
  const firstLine = text.split("\n").find(line => line.trim())?.trim() ?? ""
  if (diagnostic?.trim()) return { summary: firstLine ? shorten(firstLine) : null, details: diagnostic.trim() }
  const exitCode = exitCodeSuffix.exec(text)
  if (exitCode) {
    const lead = exitCode[1].trim().replace(/[.:;,]+$/, "")
    return { summary: lead ? `${lead}.` : null, details: text }
  }
  if (exitCodePrefix.test(text)) return { summary: null, details: text }
  if (text.length <= LONG_MESSAGE_CHARACTERS && text.split("\n").length <= LONG_MESSAGE_LINES) return { summary: text, details: null }
  return { summary: shorten(firstLine), details: text }
}

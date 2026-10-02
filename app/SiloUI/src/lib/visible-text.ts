/**
 * Guest-controlled names (files, folders, repository paths) are displayed as text, so React
 * already prevents injection, but invisible characters can still make one name look like
 * another: bidirectional overrides reorder what follows them ("gpj.exe" shown as
 * "exe.jpg"), zero-width characters hide differences, and control characters render as
 * nothing. Show each of them as a visible code point marker instead. Only display text and
 * accessible labels use this; actions keep the original name.
 */
// C0 and C1 controls, the soft hyphen, the Arabic letter mark, zero-width and bidirectional marks,
// embeddings, overrides and isolates, the word joiner and invisible operators, and the
// byte-order mark.
// oxlint-disable-next-line no-control-regex
const invisible = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

export function visibleText(text: string): string {
  return text.replace(invisible, (character) => `⟨U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`)
}

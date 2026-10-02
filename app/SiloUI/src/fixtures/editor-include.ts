import type { EditorIncludeBackend } from "@/features/application/model/editor-include"

/** `needed`: after an upgrade Silo could not add its `Include` line to the user's SSH configuration. */
const editorIncludeFixtureModes = ["needed"] as const
type EditorIncludeFixtureMode = (typeof editorIncludeFixtureModes)[number]

export function editorIncludeFixtureModeFromSearch(search: string): EditorIncludeFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("editor-include")
  return editorIncludeFixtureModes.find(mode => mode === requested)
}

export const fixtureEditorIncludeLine = 'Include "/Users/ada/.silo/3f9c1a7be204/ssh/*.conf"'

/** An in-memory backend that reports `initial` until `set` changes it, as Silo does when the file or the need changes. */
export function createFixtureEditorInclude(initial: string | null = fixtureEditorIncludeLine): EditorIncludeBackend & { set: (line: string | null) => void; calls: string[] } {
  let line = initial
  const listeners = new Set<() => void>()
  const calls: string[] = []
  return {
    calls,
    read: async () => { calls.push("read"); return line },
    subscribe: async refresh => { listeners.add(refresh); return () => { listeners.delete(refresh) } },
    set: next => { line = next; listeners.forEach(listener => listener()) },
  }
}

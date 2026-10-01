import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { z } from "zod"

import type { EditorIncludeBackend } from "@/features/application/model/editor-include"

export const desktopEditorIncludeBackend: EditorIncludeBackend = {
  read: async () => z.string().min(1).nullable().parse(await invoke("read_editor_include_notice")),
  subscribe: refresh => listen("silo://editor-include-changed", refresh),
}

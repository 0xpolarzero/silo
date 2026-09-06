import type { ApplicationWorkspace } from "@/features/application/model/application-source"
import type { SandboxIconState, SandboxRowTone } from "../components/sandbox-list"

export function workspaceIconState(workspace?: ApplicationWorkspace): SandboxIconState {
  if (workspace?.state === "failed") return "error"
  return workspace?.attention?.level ?? "normal"
}

export function workspaceRowTone(workspace?: ApplicationWorkspace): SandboxRowTone {
  if (workspace?.state === "failed" || workspace?.attention?.level === "error") return "error"
  if (workspace?.attention?.level === "warning") return "warning"
  return workspace?.state ?? "stopped"
}


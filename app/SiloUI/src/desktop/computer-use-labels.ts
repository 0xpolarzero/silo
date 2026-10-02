import type { ChatGptAppStatus, ComputerUseState } from "./linux-desktop-state"

const stateLabels: Record<ComputerUseState["state"], string> = {
  unavailable: "Unavailable",
  preparing: "Preparing…",
  installing: "Installing…",
  ready: "Ready",
  failed: "Setup failed",
}
export const computerUseLabel = (state: ComputerUseState["state"], cause?: ComputerUseState["cause"]) => state === "failed" && cause === "app-download" ? "Download failed" : stateLabels[state]

/** The one-line state of a computer's ChatGPT app, for lists. */
export function chatGptStatusText(status: ChatGptAppStatus | null) {
  switch (status?.state) {
    case "ready": return status.version ? `Ready ${status.version}` : "Ready"
    case "downloading": {
      const total = status.totalBytes ?? 0
      return total > 0 ? `Downloading ${Math.min(100, Math.round(status.receivedBytes / total * 100))}%` : "Downloading"
    }
    case "verifying": return "Verifying the download"
    case "extracting": return "Unpacking"
    case "idle": return "Waiting to download"
    case "failed": return "Failed"
    default: return "Unknown"
  }
}


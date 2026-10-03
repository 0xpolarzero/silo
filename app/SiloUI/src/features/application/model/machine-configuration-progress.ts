import type { SiloProgressEvent } from "@/contracts/silo"
import type { SandboxConfigurationOperation } from "./application-source"

export interface MachineConfigurationProgress {
  title: string
  step: string
  /** 0–1 when the position is known, else null (indeterminate). */
  progress: number | null
  /** Names of the sandboxes this operation adds. */
  creating: string[]
  /** What the operation does to the inventory; "saving" covers edits and reordering. */
  kind: "creating" | "deleting" | "saving"
}

/** Steps with no measurable progress inside them: the bar stays indeterminate. */
const UNMEASURED_STEPS = new Set(["workspace-image-import", "workspace-image-wait", "chatgpt-app-wait", "chatgpt-app-failed"])

const IMAGE_IMPORT_STEP = "Preparing the sandbox image (first time only, about a minute)"

/** "Downloading ChatGPT for Linux · 62%", without the percentage until the size is known. */
function chatGptDownloadText(event: SiloProgressEvent): string {
  const percent = event.totalBytes && event.downloadedBytes !== undefined
    ? Math.min(100, Math.floor((event.downloadedBytes / event.totalBytes) * 100))
    : null
  return percent === null ? "Downloading ChatGPT for Linux" : `Downloading ChatGPT for Linux · ${percent}%`
}

/** Whether the creation is stuck on a ChatGPT for Linux failure it can retry or finish without. */
export function chatGptFailure(operation: SandboxConfigurationOperation): string | null {
  const latest = operation.progressEvents.findLast(event => event.safeForDisplay)
  return latest?.step === "chatgpt-app-failed" ? latest.message : null
}

/** Whether the creation is waiting for ChatGPT for Linux (downloading, or failed), so it can be finished without it. */
export function waitingForChatGpt(operation: SandboxConfigurationOperation): boolean {
  const step = operation.progressEvents.findLast(event => event.safeForDisplay)?.step
  return step === "chatgpt-app-wait" || step === "chatgpt-app-download" || step === "chatgpt-app-failed"
}

/** Whether creation ended with computer use left for the first start. */
export function computerUsePending(operation: SandboxConfigurationOperation): boolean {
  return operation.progressEvents.some(event => event.step === "computer-use-pending")
}

/** The plain-words step shown under the progress bar for one backend progress event. */
export function configurationStepText(event: SiloProgressEvent | undefined): string {
  switch (event?.step) {
    case undefined:
    case "setup-started":
    case "host-memory-warning":
      return "Starting…"
    case "workspace-configuration":
      return event.fraction === 1 ? "Verifying the sandbox" : "Preparing the sandbox"
    case "workspace-disk-preparation": return "Creating disks"
    case "workspace-image-preparation": return "Checking the sandbox image"
    case "workspace-image-import": return IMAGE_IMPORT_STEP
    case "workspace-image-wait": return "Waiting for the VM image"
    case "chatgpt-app-wait": return "Waiting for ChatGPT for Linux"
    case "chatgpt-app-download": return chatGptDownloadText(event)
    case "chatgpt-app-failed": return event.message ? `ChatGPT for Linux failed: ${event.message}` : "ChatGPT for Linux download failed"
    case "computer-use-setup":
    case "computer-use-pending": return "Setting up the desktop and computer use"
    case "workspace-runtime-preparation":
    case "image-resolving":
    case "image-resolved":
    case "image-download":
    case "image-downloaded":
    case "image-verifying":
    case "image-preparing":
    case "image-ready":
    case "runtime-waiting":
      return "Creating the sandbox"
    case "desktop-installation": return "Setting up the desktop"
    case "workspace-settings": return "Saving settings"
    case "workspace-verification": return "Verifying the sandbox"
    case "workspace-removal": return "Deleting the sandbox’s files"
    case "setup-completed": return "Finishing…"
    default: return event?.message ?? "Starting…"
  }
}

// Position of a creation step among the stages it goes through; the image import is one
// stage with no measurable progress inside it.
function creationStage(step: string | undefined, fraction: number | undefined, desktop: boolean): number {
  const finishing = desktop ? 5 : 4
  switch (step) {
    case "workspace-image-wait":
    case "chatgpt-app-wait":
    case "chatgpt-app-download":
    case "chatgpt-app-failed":
    case "workspace-image-preparation":
    case "workspace-image-import": return 1
    case "workspace-runtime-preparation":
    case "image-resolving":
    case "image-resolved":
    case "image-download":
    case "image-downloaded":
    case "image-verifying":
    case "image-preparing":
    case "image-ready":
    case "runtime-waiting": return 2
    case "desktop-installation": return 3
    case "computer-use-setup":
    case "computer-use-pending": return 4
    case "workspace-settings":
    case "workspace-verification":
    case "setup-completed": return finishing
    case "workspace-configuration": return fraction === 1 ? finishing : 0
    default: return 0
  }
}

export function describeConfiguration(operation: SandboxConfigurationOperation, committedNames: ReadonlyMap<string, string>): MachineConfigurationProgress {
  const candidates = operation.candidate.machines
  const creating = candidates.filter(machine => !committedNames.has(machine.id))
  const deleting = [...committedNames.keys()].filter(id => !candidates.some(machine => machine.id === id))
  const latest = operation.progressEvents.findLast(event => event.safeForDisplay)
  const kind = creating.length > 0 ? "creating" : deleting.length > 0 ? "deleting" : "saving"
  const title = kind === "creating"
    ? creating.length === 1 ? `Creating ${creating[0].name}` : `Creating ${creating.length} sandboxes`
    : kind === "deleting"
      ? deleting.length === 1 ? `Deleting ${committedNames.get(deleting[0])}` : `Deleting ${deleting.length} sandboxes`
      : "Saving sandbox settings"
  let progress: number | null = null
  if (kind === "creating" && creating.length === 1 && latest?.step === "chatgpt-app-download" && latest.totalBytes && latest.downloadedBytes !== undefined) {
    progress = Math.min(1, latest.downloadedBytes / latest.totalBytes)
  } else if (kind === "creating" && creating.length === 1 && !UNMEASURED_STEPS.has(latest?.step ?? "")) {
    // The backend adds the built-in desktop to new sandboxes on a v4 image, so it can be absent from the request.
    const desktop = (creating[0].desktop) || operation.progressEvents.some(event => event.step === "desktop-installation" || event.step?.startsWith("chatgpt-app-") || event.step === "computer-use-setup")
    const total = desktop ? 6 : 4
    progress = Math.max(0.04, Math.min(creationStage(latest?.step, latest?.fraction, Boolean(desktop)), total - 1) / total)
  }
  return { title, step: configurationStepText(latest), progress, creating: creating.map(machine => machine.name), kind }
}

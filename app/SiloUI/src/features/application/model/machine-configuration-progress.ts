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

const IMAGE_IMPORT_STEP = "Preparing the sandbox image (first time only, about a minute)"

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
function creationStage(step: string | undefined, fraction: number | undefined): number {
  switch (step) {
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
    case "workspace-settings":
    case "workspace-verification":
    case "setup-completed": return 4
    case "workspace-configuration": return fraction === 1 ? 4 : 0
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
  if (kind === "creating" && creating.length === 1 && latest?.step !== "workspace-image-import") {
    // The backend adds the built-in desktop to new sandboxes on a v4 image, so it can be absent from the request.
    const desktop = (creating[0].kind === "vm" && creating[0].desktop) || operation.progressEvents.some(event => event.step === "desktop-installation")
    const total = desktop ? 5 : 4
    progress = Math.max(0.04, Math.min(creationStage(latest?.step, latest?.fraction), total - 1) / total)
  }
  return { title, step: configurationStepText(latest), progress, creating: creating.map(machine => machine.name), kind }
}

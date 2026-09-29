import type { ApplicationWorkspace } from "@/features/application/model/application-source"

/** Quit stops Silo-owned local VMs only; remote sandboxes keep running (decision 7). */
export function sandboxesStoppedByQuit(workspaces: ApplicationWorkspace[]): string[] {
  return workspaces
    .filter((workspace) => !workspace.computer && workspace.machine.kind === "vm" && (workspace.state === "running" || workspace.state === "starting"))
    .map(({ machine }) => machine.name)
}

export function quitConfirmationDetail(names: string[]): string {
  return `This stops ${names.length} running ${names.length === 1 ? "sandbox" : "sandboxes"}: ${names.join(", ")}.`
}

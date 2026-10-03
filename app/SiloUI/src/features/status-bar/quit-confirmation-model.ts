import type { ApplicationComputer } from "@/features/application/model/application-source"

/** Quit stops Silo-owned local computers only; remote computers keep running (decision 7). */
export function computersStoppedByQuit(computers: ApplicationComputer[]): string[] {
  return computers
    .filter((computer) => !computer.device && (computer.state === "running" || computer.state === "starting"))
    .map(({ configuration }) => configuration.name)
}

export function quitConfirmationDetail(names: string[]): string {
  return `This stops ${names.length} running ${names.length === 1 ? "computer" : "computers"}: ${names.join(", ")}.`
}

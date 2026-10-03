import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import type { SiloProgressEvent } from "@/contracts/silo"
import { createComputerUseBridge } from "@/desktop/computer-use-bridge"
import { ComputerUseProvider } from "@/desktop/computer-use-provider"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { createFixtureComputerUseBackend } from "@/fixtures/computer-use"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationWorkspace, SandboxConfigurationOperation } from "@/features/application/model/application-source"
import { describeConfiguration } from "@/features/application/model/machine-configuration-progress"

import { MachineConfigurationToast } from "./machine-configuration-toast"

afterEach(() => { toast.dismiss() })

const baseSource = structuredClone(applicationSourceForScenario("complete"))
const existing = baseSource.workspaces.filter(workspace => !workspace.computer)
const template = existing.find(workspace => workspace.machine.kind === "vm")!

function created(): ApplicationWorkspace {
  const workspace = structuredClone(template)
  workspace.machine = { ...workspace.machine, id: "vm-new", name: "fresh", desktop: { startWithSandbox: true } } as ApplicationWorkspace["machine"]
  return workspace
}

function event(step: string, fraction?: number): SiloProgressEvent {
  return { schemaVersion: 1, type: "progress", requestId: "request", phase: "workspaces", step, workspace: "fresh", fraction, message: step, safeForDisplay: true }
}

function operation(events: SiloProgressEvent[], status: "applying" = "applying"): SandboxConfigurationOperation {
  const machines = [...existing.map(workspace => workspace.machine), created().machine]
  return { id: "request", status, candidate: { schemaVersion: 1, machines } as never, progressEvents: events, result: null, error: null }
}

const committed = new Map(existing.map(workspace => [workspace.machine.id, workspace.machine.name]))

describe("describeConfiguration", () => {
  it("names the step in plain words with an indeterminate bar during the first-time image import", () => {
    const described = describeConfiguration(operation([event("workspace-disk-preparation"), event("workspace-image-preparation"), event("workspace-image-import")]), committed)
    expect(described).toMatchObject({ title: "Creating fresh", step: "Preparing the sandbox image (first time only, about a minute)", progress: null, kind: "creating" })
  })

  it("shows a bar from the very first event, before any step arrives", () => {
    const described = describeConfiguration(operation([]), committed)
    expect(described.step).toBe("Starting…")
    expect(described.progress).toBeGreaterThan(0)
  })

  it("advances the bar through disks, sandbox and desktop", () => {
    const at = (step: string) => describeConfiguration(operation([event(step, 0)]), committed)
    expect(at("workspace-disk-preparation")).toMatchObject({ step: "Creating disks" })
    const values = ["workspace-disk-preparation", "workspace-image-preparation", "workspace-runtime-preparation", "desktop-installation", "workspace-verification"].map(step => at(step).progress!)
    expect(values).toEqual([...values].sort((a, b) => a - b))
    expect(at("desktop-installation").step).toBe("Setting up the desktop")
  })
})

function Harness({ current, workspaces, onOpen }: { current: SandboxConfigurationOperation | null; workspaces: ApplicationWorkspace[]; onOpen?: (id: string) => void }) {
  const bridge = createComputerUseBridge(createFixtureComputerUseBackend("ready", "idle"))
  return <SettingsProvider initialSettings={{ theme: "light" }}>
    <ComputerUseProvider bridge={bridge}>
      <Toaster />
      <MachineConfigurationToast operation={current} workspaces={workspaces} onOpen={onOpen} />
    </ComputerUseProvider>
  </SettingsProvider>
}

describe("MachineConfigurationToast", () => {
  it("shows the current step at once and replaces it with Created and the approval switch", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const view = render(<Harness current={operation([])} workspaces={existing} onOpen={onOpen} />)
    expect(await screen.findByText("Creating fresh")).toBeVisible()
    expect(screen.getByRole("progressbar")).toBeInTheDocument()

    view.rerender(<Harness current={operation([event("workspace-image-import")])} workspaces={existing} onOpen={onOpen} />)
    expect(await screen.findByText("Preparing the sandbox image (first time only, about a minute)")).toBeVisible()

    view.rerender(<Harness current={null} workspaces={[...existing, created()]} onOpen={onOpen} />)
    expect(await screen.findByText("Created fresh")).toBeVisible()
    const approval = await screen.findByRole("switch", { name: "Allow without asking" })
    expect(approval).not.toBeChecked()
    await user.click(approval)
    await waitFor(() => expect(approval).toBeChecked())
    await user.click(screen.getByRole("button", { name: "Open" }))
    expect(onOpen).toHaveBeenCalledWith("vm-new")
  })

  it("offers no switch for a sandbox without built-in computer use", async () => {
    const view = render(<Harness current={operation([])} workspaces={existing} />)
    expect(await screen.findByText("Creating fresh")).toBeVisible()
    const plain = created()
    plain.machine = { ...plain.machine, desktop: undefined } as ApplicationWorkspace["machine"]
    view.rerender(<Harness current={null} workspaces={[...existing, plain]} />)
    expect(await screen.findByText("Created fresh")).toBeVisible()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
  })
})

import { render, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions } from "../model/application-source"
import { workspaceTarget } from "../model/remote-computers"
import { OverviewPage } from "../pages/overview-page"

function openSandboxPage(active: boolean, refreshNetwork: ApplicationActions["refreshNetwork"]) {
  const source = structuredClone(applicationSourceForScenario("complete"))
  source.remoteComputers = []
  const workspace = source.workspaces.find(item => item.machine.kind === "vm" && !item.computer)!
  workspace.state = "running"
  workspace.freshness = "fresh"
  source.network = { workspaces: [{ workspace: workspaceTarget(workspace), error: null, ports: [] }] }
  const actions = { refreshNetwork, saveNetworkPort: vi.fn(), removeNetworkPort: vi.fn(), openNetworkPort: vi.fn() } as unknown as ApplicationActions
  const page = (visible: boolean) => <OverviewPage active={visible} source={source} actions={actions} onMachinesChange={vi.fn()}
    selectedSandboxId={workspace.machine.id} sandboxTab="overview" onOpenSandbox={vi.fn()} onCloseSandbox={vi.fn()} onSelectSandboxTab={vi.fn()} />
  const view = render(page(active))
  return { ...view, show: () => view.rerender(page(true)) }
}

it("does not poll a sandbox's ports while the Sandboxes panel is hidden", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  try {
    const refreshNetwork = vi.fn(async () => {})
    const { show } = openSandboxPage(false, refreshNetwork)
    vi.advanceTimersByTime(20_000)
    expect(refreshNetwork).not.toHaveBeenCalled()

    show()
    await waitFor(() => expect(refreshNetwork).toHaveBeenCalledTimes(1))
    vi.advanceTimersByTime(5_000)
    expect(refreshNetwork).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const output = Array.from({ length: 30 }, (_, index) => `msb: stage ${index}: exec failed`).join("\n")
const page = (source: ApplicationSource, actions = {} as ApplicationActions) =>
  <><Toaster /><OverviewPage source={structuredClone(source)} actions={actions} onMachinesChange={vi.fn()} /></>

it("summarizes a long lifecycle failure and keeps the runtime output behind Details", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.state = "stopped"
  const view = render(page(source))
  workspace.lifecycleFailure = `Start failed: the VM did not boot\n${output}\n[Diagnostic truncated]`
  workspace.lifecycleFailureAction = "start"
  view.rerender(page(source))
  expect(await screen.findByText("Could not start dev")).toBeVisible()
  expect(screen.getByText("Start failed: the VM did not boot")).toBeVisible()
  expect(screen.queryByText(/stage 29/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Show details" }))
  expect(screen.getByLabelText("Error details")).toHaveTextContent("msb: stage 29: exec failed")
})

it("summarizes a long sandbox setup failure in the configuration alert", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  source.sandboxConfigurationOperation = {
    id: "setup", status: "failed", result: null, progressEvents: [],
    candidate: { schemaVersion: 1, machines: source.workspaces.map(({ machine }) => machine) },
    error: { code: "native_bridge_failed", workspace: null, message: `Sandbox setup failed (exit code 3): ${output}`, recovery: null, retryable: true },
  }
  render(page(source, { dismissMachineConfigurationError: vi.fn() } as unknown as ApplicationActions))
  const alert = screen.getAllByRole("alert").find(element => element.textContent?.includes("Sandbox setup failed."))!
  expect(within(alert).getByText("Sandbox setup failed.")).toBeVisible()
  expect(within(alert).queryByText(/exit code/)).not.toBeInTheDocument()
  expect(within(alert).getByRole("button", { name: "Show details" })).toBeVisible()
})

it("keeps the runtime's separate lifecycle diagnostic available behind Details", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const workspace = source.workspaces.find(item => item.machine.name === "dev")!
  workspace.state = "stopped"
  const view = render(page(source))
  workspace.lifecycleFailure = "The sandbox did not start. Review the details and retry."
  workspace.lifecycleFailureDiagnostic = output
  workspace.lifecycleFailureAction = "start"
  view.rerender(page(source))
  expect(await screen.findByText(workspace.lifecycleFailure)).toBeVisible()
  expect(screen.queryByText(/stage 29/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Show details" }))
  expect(screen.getByLabelText("Error details")).toHaveTextContent("msb: stage 29: exec failed")
})

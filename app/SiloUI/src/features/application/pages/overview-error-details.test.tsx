import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, ApplicationSource } from "../model/application-source"
import { OverviewPage } from "./overview-page"

const output = Array.from({ length: 30 }, (_, index) => `msb: stage ${index}: exec failed`).join("\n")
const page = (source: ApplicationSource, actions = {} as ApplicationActions) =>
  <><Toaster /><OverviewPage source={structuredClone(source)} actions={actions} onConfigurationsChange={vi.fn()} /></>

it("summarizes a long lifecycle failure and keeps the runtime output behind Details", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.state = "stopped"
  const view = render(page(source))
  computer.lifecycleFailure = `Start failed: the VM did not boot\n${output}\n[Diagnostic truncated]`
  computer.lifecycleFailureAction = "start"
  view.rerender(page(source))
  expect(await screen.findByText("Could not start dev")).toBeVisible()
  expect(screen.getByText("Start failed: the VM did not boot")).toBeVisible()
  expect(screen.queryByText(/stage 29/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Show details" }))
  expect(screen.getByLabelText("Error details")).toHaveTextContent("msb: stage 29: exec failed")
})

it("summarizes a long computer setup failure in the configuration alert", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  source.computerConfigurationOperation = {
    id: "setup", status: "failed", result: null, progressEvents: [],
    candidate: { schemaVersion: 1, computers: source.computers.map(({ configuration }) => configuration) },
    error: { code: "native_bridge_failed", computer: null, message: `Computer setup failed (exit code 3): ${output}`, recovery: null, retryable: true },
  }
  render(page(source, { dismissComputerConfigurationError: vi.fn() } as unknown as ApplicationActions))
  const alert = screen.getAllByRole("alert").find(element => element.textContent?.includes("Computer setup failed."))!
  expect(within(alert).getByText("Computer setup failed.")).toBeVisible()
  expect(within(alert).queryByText(/exit code/)).not.toBeInTheDocument()
  expect(within(alert).getByRole("button", { name: "Show details" })).toBeVisible()
})

it("keeps the runtime's separate lifecycle diagnostic available behind Details", async () => {
  const source = structuredClone(applicationSourceForScenario("complete"))
  const computer = source.computers.find(item => item.configuration.name === "dev")!
  computer.state = "stopped"
  const view = render(page(source))
  computer.lifecycleFailure = "The computer did not start. Review the details and retry."
  computer.lifecycleFailureDiagnostic = output
  computer.lifecycleFailureAction = "start"
  view.rerender(page(source))
  expect(await screen.findByText(computer.lifecycleFailure)).toBeVisible()
  expect(screen.queryByText(/stage 29/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Show details" }))
  expect(screen.getByLabelText("Error details")).toHaveTextContent("msb: stage 29: exec failed")
})

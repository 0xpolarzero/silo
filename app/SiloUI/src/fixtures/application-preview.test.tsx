import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"
import { ApplicationPreview } from "./application-preview"
import { applicationSourceForScenario } from "./application-scenarios"

it.each([false, true])("keeps SSH settings for a sandbox named constructor (seeded=%s)", async seeded => {
  const source = structuredClone(applicationSourceForScenario("running"))
  const workspace = source.workspaces[0]
  workspace.machine.name = "constructor"
  source.workspaces = [workspace]
  source.sshAccess = seeded ? { workspaces: [{
    workspace: "constructor", enabled: true, port: 2424, bindAddress: "127.0.0.1", keys: [],
    state: "listening", message: null, fingerprint: null, deviceName: "Fixture device", addresses: ["127.0.0.1"],
  }] } : undefined
  render(<ApplicationPreview source={source} initialRoute={{ workspace: workspace.machine.id, sandboxTab: "access" }} />)
  expect(screen.getByRole("tab", { name: "SSH" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByText(`ssh -p ${seeded ? 2424 : 2222} silo@127.0.0.1`)).toBeVisible()
  const toggle = screen.getByRole("switch", { name: `Allow SSH from ${seeded ? "Fixture device" : "Ada’s Mac mini"}` })
  expect(toggle).toBeChecked()
  await userEvent.setup().click(toggle)
  expect(toggle).not.toBeChecked()
})

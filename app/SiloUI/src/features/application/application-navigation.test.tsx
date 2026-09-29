import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

function sandboxesPanel() {
  return within(screen.getByRole("region", { name: "Sandboxes" }))
}

it("replaces a deleted sandbox's page in history instead of pushing the list after it", async () => {
  const user = userEvent.setup()
  const source = applicationSourceForScenario("running")
  const view = render(<ApplicationPreview source={source} />)
  await user.click(sandboxesPanel().getByRole("button", { name: "Open playgrounds" }))
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Sandboxesplaygrounds")

  view.rerender(<ApplicationPreview source={{ ...source, workspaces: source.workspaces.filter(({ machine }) => machine.name !== "playgrounds") }} />)

  expect(sandboxesPanel().getByRole("list", { name: "Configured sandboxes" })).toBeVisible()
  // Back would otherwise land on the deleted sandbox's entry and bounce forward again.
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled()
})

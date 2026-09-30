import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

it("opens the new-sandbox editor from a sandbox page when there are no sandboxes yet", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  source.workspaces = []
  source.repositoryPushOperations = []
  const user = userEvent.setup()
  render(<ApplicationPreview source={source} initialRoute={{ workspaceSection: "files" }} />)
  expect(screen.getByText("No sandboxes yet")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "New sandbox" }))
  expect(await screen.findByRole("textbox", { name: "Machine name" })).toHaveFocus()
})

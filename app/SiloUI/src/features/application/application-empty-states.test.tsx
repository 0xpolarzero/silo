import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { ApplicationPreview } from "@/fixtures/application-preview"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

it("opens the new-computer editor from a computer page when there are no computers yet", async () => {
  const source = structuredClone(applicationSourceForScenario("running"))
  source.computers = []
  source.repositoryPushOperations = []
  const user = userEvent.setup()
  render(<ApplicationPreview source={source} initialRoute={{ computerSection: "files" }} />)
  expect(screen.getByText("No computers yet")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "New computer" }))
  expect(await screen.findByRole("textbox", { name: "Computer name" })).toHaveFocus()
})

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { validateSandboxName } from "@/features/onboarding/model/machine-configuration"
import { ImportPopover } from "./import-popover"

describe("import name validation accessibility", () => {
  it.each(["dev", "invalid name"])("keeps the name label stable and describes the error for %s", async (newName) => {
    render(<ImportPopover
      source={applicationSourceForScenario("running")}
      review={{ kind: "review", archive: { name: "export", archivePath: "/fixtures/export", completedLabel: "Today", size: "1 GiB", destination: "/fixtures", sandboxes: ["dev"] }, sourceName: "dev", newName }}
      anchor={<button type="button">Add</button>}
      onReview={vi.fn()} onImport={vi.fn()} onClose={vi.fn()} onRetry={vi.fn()}
    />)
    const input = await screen.findByRole("textbox", { name: /New sandbox name/ })
    expect(input).toHaveAccessibleName("New sandbox name")
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription(validateSandboxName(newName) ?? `A sandbox named ${newName} already exists.`)
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
  })
})

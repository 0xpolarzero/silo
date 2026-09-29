import { render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

it("keeps row controls mounted and in place across a busy transition", () => {
  const machine = productionMachineDefaults[0]
  const onMachinesChange = vi.fn()
  const view = (busy: boolean) => <TooltipProvider><MachineList
    machines={[machine]}
    onMachinesChange={onMachinesChange}
    getRowPresentation={() => ({
      busy,
      suppressInteractions: busy,
      menuActions: [{ label: "Checkpoints", onSelect: vi.fn() }],
    })}
  /></TooltipProvider>

  const { rerender } = render(view(false))
  const menu = screen.getByRole("button", { name: `More actions for ${machine.name}` })
  const reorder = screen.getByRole("button", { name: `Reorder ${machine.name}` })
  expect(menu).toBeEnabled()
  expect(reorder).toHaveAttribute("tabindex", "0")

  rerender(view(true))
  expect(screen.getByRole("button", { name: `More actions for ${machine.name}` })).toBe(menu)
  expect(menu).toBeDisabled()
  expect(screen.getByRole("button", { name: `Reorder ${machine.name}` })).toBe(reorder)
  expect(reorder).toHaveAttribute("aria-disabled", "true")
  expect(reorder).toHaveAttribute("tabindex", "-1")

  rerender(view(false))
  expect(screen.getByRole("button", { name: `More actions for ${machine.name}` })).toBe(menu)
  expect(menu).toBeEnabled()
  expect(reorder).not.toHaveAttribute("aria-disabled")
  expect(reorder).toHaveAttribute("tabindex", "0")
})

it("keeps the sandbox name field free of auto-capitalization and autocorrect", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  const name = await screen.findByRole("textbox", { name: "Machine name" })
  expect(name).toHaveAttribute("autocapitalize", "off")
  expect(name).toHaveAttribute("autocorrect", "off")
  expect(name).toHaveAttribute("spellcheck", "false")
})

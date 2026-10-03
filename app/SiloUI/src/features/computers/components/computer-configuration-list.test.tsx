import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionComputerDefaults } from "@/features/onboarding/model/computer-configuration"
import { ComputerConfigurationList } from "./computer-configuration-list"

it("keeps row controls mounted and in place across a busy transition", async () => {
  const configuration = productionComputerDefaults[0]
  const onConfigurationsChange = vi.fn()
  const view = (busy: boolean) => <TooltipProvider><ComputerConfigurationList
    configurations={[configuration]}
    onConfigurationsChange={onConfigurationsChange}
    getRowPresentation={() => ({
      busy,
      suppressInteractions: busy,
      menuActions: [{ label: "Checkpoints", onSelect: vi.fn() }],
    })}
  /></TooltipProvider>

  const { rerender } = render(view(false))
  const menu = screen.getByRole("button", { name: `More actions for ${configuration.name}` })
  const reorder = screen.getByRole("button", { name: `Reorder ${configuration.name}` })
  expect(menu).toBeEnabled()
  expect(reorder).toHaveAttribute("tabindex", "0")

  rerender(view(true))
  expect(screen.getByRole("button", { name: `More actions for ${configuration.name}` })).toBe(menu)
  // Busy rows keep their menu for navigation; only the items that change the computer lock.
  expect(menu).toBeEnabled()
  await userEvent.setup().click(menu)
  expect(screen.getByRole("menuitem", { name: `Edit ${configuration.name}` })).toHaveAttribute("data-disabled")
  expect(screen.getByRole("menuitem", { name: "Checkpoints" })).not.toHaveAttribute("data-disabled")
  await userEvent.setup().keyboard("{Escape}")
  expect(screen.getByRole("button", { name: `Reorder ${configuration.name}` })).toBe(reorder)
  expect(reorder).toHaveAttribute("aria-disabled", "true")
  expect(reorder).toHaveAttribute("tabindex", "-1")

  rerender(view(false))
  expect(screen.getByRole("button", { name: `More actions for ${configuration.name}` })).toBe(menu)
  expect(menu).toBeEnabled()
  expect(reorder).not.toHaveAttribute("aria-disabled")
  expect(reorder).toHaveAttribute("tabindex", "0")
})

it("reorders only this device's computers, around remote rows", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const base = productionComputerDefaults[0]
  const first = { ...base, id: "00000000-0000-4000-8000-00000000000a", name: "first" }
  const remote = { ...base, id: "00000000-0000-4000-8000-00000000000b", name: "remote" }
  const second = { ...base, id: "00000000-0000-4000-8000-00000000000c", name: "second" }
  const onConfigurationsChange = vi.fn()
  render(<TooltipProvider><ComputerConfigurationList configurations={[first, remote, second]} onConfigurationsChange={onConfigurationsChange}
    getDeviceId={(configuration) => configuration.id === remote.id ? "office" : undefined} /></TooltipProvider>)
  // A remote computer's order is its own device's: it offers no reorder control.
  expect(screen.queryByRole("button", { name: "Reorder remote" })).not.toBeInTheDocument()
  screen.getByRole("button", { name: "Reorder first" }).focus()
  await userEvent.setup().keyboard("{ArrowDown}")
  expect(onConfigurationsChange).toHaveBeenCalledExactlyOnceWith([second, first], [first, second])
  expect(screen.getByText("first moved to position 2 of 2.")).toBeInTheDocument()
})

it("waits for the source to publish a keyboard move before the next one", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const base = productionComputerDefaults[0]
  const [a, b, c] = ["a", "b", "c"].map((name, index) => ({ ...base, id: `00000000-0000-4000-8000-00000000001${index}`, name }))
  const onConfigurationsChange = vi.fn(() => new Promise<void>(() => {}))
  const view = (configurations: typeof base[]) => <TooltipProvider><ComputerConfigurationList configurations={configurations} onConfigurationsChange={onConfigurationsChange} /></TooltipProvider>
  const { rerender } = render(view([a, b, c]))
  const user = userEvent.setup()
  screen.getByRole("button", { name: "Reorder a" }).focus()
  await user.keyboard("{ArrowDown}{ArrowDown}")
  // The second press would have recomputed from the stale order and repeated the first move.
  expect(onConfigurationsChange).toHaveBeenCalledExactlyOnceWith([b, a, c], [a, b, c])
  rerender(view([b, a, c]))
  screen.getByRole("button", { name: "Reorder a" }).focus()
  await user.keyboard("{ArrowDown}")
  expect(onConfigurationsChange).toHaveBeenLastCalledWith([b, c, a], [b, a, c])
})

it("keeps the computer name field free of auto-capitalization and autocorrect", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const user = userEvent.setup()
  render(<TooltipProvider><ComputerConfigurationList configurations={[]} onConfigurationsChange={vi.fn()} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New computer" }))
  const name = await screen.findByRole("textbox", { name: "Computer name" })
  expect(name).toHaveAttribute("autocapitalize", "off")
  expect(name).toHaveAttribute("autocorrect", "off")
  expect(name).toHaveAttribute("spellcheck", "false")
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { MachineList } from "./machine-list"

it("keeps row controls mounted and in place across a busy transition", async () => {
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
  // Busy rows keep their menu for navigation; only the items that change the sandbox lock.
  expect(menu).toBeEnabled()
  await userEvent.setup().click(menu)
  expect(screen.getByRole("menuitem", { name: `Edit ${machine.name}` })).toHaveAttribute("data-disabled")
  expect(screen.getByRole("menuitem", { name: "Checkpoints" })).not.toHaveAttribute("data-disabled")
  await userEvent.setup().keyboard("{Escape}")
  expect(screen.getByRole("button", { name: `Reorder ${machine.name}` })).toBe(reorder)
  expect(reorder).toHaveAttribute("aria-disabled", "true")
  expect(reorder).toHaveAttribute("tabindex", "-1")

  rerender(view(false))
  expect(screen.getByRole("button", { name: `More actions for ${machine.name}` })).toBe(menu)
  expect(menu).toBeEnabled()
  expect(reorder).not.toHaveAttribute("aria-disabled")
  expect(reorder).toHaveAttribute("tabindex", "0")
})

it("reorders only this device's sandboxes, around remote rows", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const base = productionMachineDefaults[0]
  const first = { ...base, id: "00000000-0000-4000-8000-00000000000a", name: "first" }
  const remote = { ...base, id: "00000000-0000-4000-8000-00000000000b", name: "remote" }
  const second = { ...base, id: "00000000-0000-4000-8000-00000000000c", name: "second" }
  const onMachinesChange = vi.fn()
  render(<TooltipProvider><MachineList machines={[first, remote, second]} onMachinesChange={onMachinesChange}
    getDeviceId={(machine) => machine.id === remote.id ? "office" : undefined} /></TooltipProvider>)
  // A remote sandbox's order is its own device's: it offers no reorder control.
  expect(screen.queryByRole("button", { name: "Reorder remote" })).not.toBeInTheDocument()
  screen.getByRole("button", { name: "Reorder first" }).focus()
  await userEvent.setup().keyboard("{ArrowDown}")
  expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([second, first], [first, second])
  expect(screen.getByText("first moved to position 2 of 2.")).toBeInTheDocument()
})

it("waits for the source to publish a keyboard move before the next one", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const base = productionMachineDefaults[0]
  const [a, b, c] = ["a", "b", "c"].map((name, index) => ({ ...base, id: `00000000-0000-4000-8000-00000000001${index}`, name }))
  const onMachinesChange = vi.fn(() => new Promise<void>(() => {}))
  const view = (machines: typeof base[]) => <TooltipProvider><MachineList machines={machines} onMachinesChange={onMachinesChange} /></TooltipProvider>
  const { rerender } = render(view([a, b, c]))
  const user = userEvent.setup()
  screen.getByRole("button", { name: "Reorder a" }).focus()
  await user.keyboard("{ArrowDown}{ArrowDown}")
  // The second press would have recomputed from the stale order and repeated the first move.
  expect(onMachinesChange).toHaveBeenCalledExactlyOnceWith([b, a, c], [a, b, c])
  rerender(view([b, a, c]))
  screen.getByRole("button", { name: "Reorder a" }).focus()
  await user.keyboard("{ArrowDown}")
  expect(onMachinesChange).toHaveBeenLastCalledWith([b, c, a], [b, a, c])
})

it("keeps the sandbox name field free of auto-capitalization and autocorrect", async () => {
  const { default: userEvent } = await import("@testing-library/user-event")
  const user = userEvent.setup()
  render(<TooltipProvider><MachineList machines={[]} onMachinesChange={vi.fn()} /></TooltipProvider>)
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  const name = await screen.findByRole("textbox", { name: "Sandbox name" })
  expect(name).toHaveAttribute("autocapitalize", "off")
  expect(name).toHaveAttribute("autocorrect", "off")
  expect(name).toHaveAttribute("spellcheck", "false")
})


it("counts SSH hosts separately from local and remote sandboxes", () => {
  const local = productionMachineDefaults[0]
  const remote = { ...local, id: "00000000-0000-4000-8000-00000000000b", name: "remote" }
  const ssh = { kind: "ssh" as const, id: "00000000-0000-4000-8000-00000000000c", name: "server", host: "server.example", user: "dev", port: 22 }
  render(<TooltipProvider><MachineList machines={[local, remote, ssh]} onMachinesChange={vi.fn()}
    getDeviceId={machine => machine.id === remote.id ? "office" : undefined} /></TooltipProvider>)
  expect(screen.getByText("2 sandboxes · 1 on this device · 1 on other devices · 1 SSH host")).toBeVisible()
  expect(screen.getByText("SSH host")).toBeVisible()
})

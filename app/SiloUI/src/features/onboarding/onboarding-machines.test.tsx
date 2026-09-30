import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { OnboardingPreview } from "@/fixtures/onboarding-preview"

import type { GitHubConnectionState } from "@/features/onboarding/model/onboarding-source"

import { onboardingScenarios, repositoryFixtures } from "@/fixtures/scenarios"

function renderScenario(name: keyof typeof onboardingScenarios = "running", githubState?: GitHubConnectionState) {
  return render(<OnboardingPreview source={onboardingScenarios[name]} initialGitHubConnectionState={githubState} repositoryOptions={repositoryFixtures} actions={{
    saveMachineConfiguration: vi.fn(),
    retryWorkspaceSetup: vi.fn(),
    finishSetup: vi.fn(),
  }} />)
}

async function renderMachineScenario() {
  const saveMachineConfiguration = vi.fn()
  const user = userEvent.setup()
  render(<OnboardingPreview
    source={onboardingScenarios.running}
    repositoryOptions={repositoryFixtures}
    actions={{
      saveMachineConfiguration,
      retryWorkspaceSetup: vi.fn(),
      finishSetup: vi.fn(),
    }}
  />)
  await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
  return { user, saveMachineConfiguration }
}


it("starts from the exact three production machine defaults instead of the activity stress fixture", async () => {
  await renderMachineScenario()
  const list = screen.getByRole("list", { name: "Configured sandboxes" })
  const rows = within(list).getAllByRole("listitem")

  expect(rows).toHaveLength(3)
  expect(rows.map((row) => within(row).getByText(/^(dev|playgrounds|personal)$/).textContent)).toEqual(["dev", "playgrounds", "personal"])
  expect(rows[0]).toHaveTextContent("CPUs: 8 · Memory: 32 GiB · Disk: 120 GiB")
  expect(rows[1]).toHaveTextContent("CPUs: 4 · Memory: 32 GiB · Disk: 60 GiB")
  expect(rows[2]).toHaveTextContent("CPUs: 6 · Memory: 16 GiB · Disk: 100 GiB")
  expect(within(list).queryByText("docs-build")).not.toBeInTheDocument()
})


it("adds, cancels, and saves a virtual machine through the typed configuration action", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  const draftName = screen.getByRole("textbox", { name: "Sandbox name" })
  expect(draftName).toHaveValue("workspace-4")
  expect(draftName).toHaveFocus()
  expect(screen.getByRole("combobox", { name: "CPUs" })).toHaveValue("8")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByDisplayValue("workspace-4")).not.toBeInTheDocument()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.clear(screen.getByRole("textbox", { name: "Sandbox name" }))
  await user.type(screen.getByRole("textbox", { name: "Sandbox name" }), "build")
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(saveMachineConfiguration).toHaveBeenCalledOnce()
  expect(saveMachineConfiguration.mock.lastCall?.[0]).toMatchObject({
    schemaVersion: 1,
    machines: [
      { kind: "vm", name: "dev" },
      { kind: "vm", name: "playgrounds" },
      { kind: "vm", name: "personal" },
      { kind: "vm", name: "build", cpus: 4, maxCPUs: 12, memoryGiB: 32, maxMemoryGiB: 48, workspaceStorageGiB: 120, runtimeStorageGiB: 100 },
    ],
  })
  expect(screen.getByRole("list", { name: "Configured sandboxes" })).toHaveTextContent("build")
})


it("adds, validates, cancels, and saves an SSH machine without claiming a connection", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "Connect an SSH host…" }))
  expect(screen.getByRole("textbox", { name: "SSH host name" })).toHaveValue("remote-1")
  expect(screen.getByRole("spinbutton", { name: "SSH port" })).toHaveValue(22)
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByText("Enter an SSH host.")).toBeVisible()
  expect(screen.getByText("Enter an SSH user.")).toBeVisible()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByDisplayValue("remote-1")).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "Connect an SSH host…" }))
  await user.clear(screen.getByRole("textbox", { name: "SSH host name" }))
  await user.type(screen.getByRole("textbox", { name: "SSH host name" }), "staging")
  await user.type(screen.getByRole("textbox", { name: "SSH host" }), "staging.example.com")
  await user.type(screen.getByRole("textbox", { name: "SSH user" }), "deploy")
  await user.clear(screen.getByRole("spinbutton", { name: "SSH port" }))
  await user.type(screen.getByRole("spinbutton", { name: "SSH port" }), "2222")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.at(-1)).toMatchObject({
    kind: "ssh",
    name: "staging",
    host: "staging.example.com",
    user: "deploy",
    port: 2222,
  })
  const panel = within(screen.getByRole("tabpanel"))
  expect(panel.getByText("deploy@staging.example.com:2222")).toBeVisible()
  expect(panel.queryByText(/connected/i)).not.toBeInTheDocument()
}, 15_000)
 // This full form/navigation flow exceeds 5 seconds on Linux CI.

it("restores an existing VM exactly on Cancel and persists a valid edit on Save", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Edit dev" }))
  const name = screen.getByRole("textbox", { name: "Sandbox name" })
  expect(name).toHaveFocus()
  expect(name).toHaveAttribute("readonly")
  expect(screen.getByRole("combobox", { name: "Workspace disk" })).toBeDisabled()
  expect(screen.getByRole("combobox", { name: "Runtime disk" })).toBeDisabled()
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory" }), "16")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Edit dev" })).toBeVisible()

  await user.click(screen.getByRole("button", { name: "Edit dev" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory" }), "16")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines[0]).toMatchObject({ name: "dev", memoryGiB: 16 })
  expect(screen.getByRole("button", { name: "Edit dev" })).toBeVisible()
})


it("keeps machine actions on one custom tooltip and the drag handle tooltip-free", async () => {
  const { user } = await renderMachineScenario()
  const dragHandle = screen.getByRole("button", { name: "Reorder dev" })
  expect(dragHandle).toHaveAccessibleName("Reorder dev")
  expect(dragHandle).not.toHaveAttribute("title")
  await user.click(dragHandle)
  await user.keyboard("{ArrowDown}")
  fireEvent.blur(dragHandle)
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())

  const tooltipCases = [
    ["Edit dev", "Edit dev"],
    ["Duplicate settings for dev", "Create a new empty sandbox with the same settings."],
    ["Delete dev", "Delete dev"],
  ] as const

  for (const [name, explanation] of tooltipCases) {
    const trigger = screen.getByRole("button", { name })
    expect(trigger).toHaveAccessibleName(name)
    expect(trigger).not.toHaveAttribute("title")
    fireEvent.focus(trigger)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(explanation)
    expect(screen.getAllByRole("tooltip")).toHaveLength(1)
    fireEvent.blur(trigger)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())

    await user.hover(trigger)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(explanation)
    expect(screen.getAllByRole("tooltip")).toHaveLength(1)
    await user.unhover(trigger)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument())
  }

  await user.click(screen.getByRole("button", { name: "Delete dev" }))
  expect(screen.getByText("Delete dev permanently?")).toBeVisible()
})


it("preserves GitHub policy and identity settings when VM resources change", async () => {
  const user = userEvent.setup()
  renderScenario("running", "connected")
  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  await user.clear(screen.getByLabelText("Git name for dev"))
  await user.type(screen.getByLabelText("Git name for dev"), "Renamed Author")
  expect(within(screen.getByRole("table", { name: "Selected repositories for dev" })).getByText("acme/silo")).toBeVisible()

  await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
  await user.click(screen.getByRole("button", { name: "Edit dev" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))

  await user.click(screen.getByRole("tab", { name: /GitHub/ }))
  expect(screen.getByLabelText("Git name for dev")).toHaveValue("Renamed Author")
  expect(within(screen.getByRole("table", { name: "Selected repositories for dev" })).getByText("acme/silo")).toBeVisible()
})


it("duplicates after the source, cancels drafts, and generates collision-free copy names", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveValue("dev-copy")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(saveMachineConfiguration).not.toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual(["dev", "dev-copy", "playgrounds", "personal"])

  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveValue("dev-copy-2")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual(["dev", "dev-copy-2", "dev-copy", "playgrounds", "personal"])
})


it("places a replacement duplicate after its source when another draft is open", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  await user.click(screen.getByRole("button", { name: "Duplicate settings for playgrounds" }))
  expect(screen.getByRole("textbox", { name: "Sandbox name" })).toHaveValue("playgrounds-copy")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual([
    "dev", "playgrounds", "playgrounds-copy", "personal",
  ])
})


it("confirms deletion in a popover; Cancel or Escape keeps the sandbox", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()

  await user.click(screen.getByRole("button", { name: "Delete dev" }))
  expect(screen.getByText("Delete dev permanently?")).toBeVisible()
  expect(screen.getByText("Its files and checkpoints will be deleted. This can't be undone.")).toBeVisible()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.queryByText("Delete dev permanently?")).not.toBeInTheDocument()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Delete dev" }))
  await user.keyboard("{Escape}")
  expect(screen.queryByText("Delete dev permanently?")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Delete dev" })).toBeVisible()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "Delete dev" }))
  await user.click(screen.getByRole("button", { name: /^Delete permanently$/ }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual(["playgrounds", "personal"])
  expect(screen.queryByRole("button", { name: "Edit dev" })).not.toBeInTheDocument()
})


it("persists pointer drag reorder and the quiet keyboard reorder path", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()
  const data = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: "none",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  }
  const target = screen.getByRole("button", { name: "Edit personal" }).closest("li")
  expect(target).not.toBeNull()

  fireEvent.dragStart(screen.getByRole("button", { name: "Reorder dev" }), { dataTransfer })
  fireEvent.dragOver(target!, { dataTransfer })
  fireEvent.drop(target!, { dataTransfer })
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual(["playgrounds", "personal", "dev"])

  const devHandle = screen.getByRole("button", { name: "Reorder dev" })
  devHandle.focus()
  await user.keyboard("{ArrowUp}")
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines.map(({ name }: { name: string }) => name)).toEqual(["playgrounds", "dev", "personal"])
  expect(screen.getByText("dev moved to position 2 of 3.")).toBeInTheDocument()
})


it("saves smaller memory presets and custom whole GiB values", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()
  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory" }), "12")
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory ceiling" }), "12")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "dev-copy", memoryGiB: 12, maxMemoryGiB: 12 }),
  ]))
  await user.click(screen.getByRole("button", { name: "Edit dev-copy" }))
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory" }), "custom")
  const input = screen.getByRole("spinbutton", { name: "Memory custom (GiB)" })
  await user.clear(input)
  await user.type(input, "10")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "dev-copy", memoryGiB: 10, maxMemoryGiB: 12 }),
  ]))
  await user.click(screen.getByRole("button", { name: "Edit dev-copy" }))
  expect(screen.getByRole("spinbutton", { name: "Memory custom (GiB)" })).toHaveValue(10)
  saveMachineConfiguration.mockClear()
  const customInput = screen.getByRole("spinbutton", { name: "Memory custom (GiB)" })
  for (const invalid of ["0", "1.5", "13"]) {
    await user.clear(customInput)
    await user.type(customInput, invalid)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(saveMachineConfiguration).not.toHaveBeenCalled()
  }
  await user.selectOptions(screen.getByRole("combobox", { name: "Memory" }), "8")
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "dev-copy", memoryGiB: 8, maxMemoryGiB: 12 }),
  ]))
})


it("saves custom CPU and disk values and reopens them", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()
  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  for (const [label, unit, value] of [["CPUs", "CPUs", "3"], ["CPUs ceiling", "CPUs", "5"], ["Workspace disk", "GiB", "35"], ["Runtime disk", "GiB", "25"]]) {
    await user.selectOptions(screen.getByRole("combobox", { name: label }), "custom")
    const input = screen.getByRole("spinbutton", { name: `${label} custom (${unit})` })
    await user.clear(input)
    await user.type(input, value)
  }
  await user.click(screen.getByRole("button", { name: "Save" }))
  expect(saveMachineConfiguration.mock.lastCall?.[0].machines).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "dev-copy", cpus: 3, maxCPUs: 5, workspaceStorageGiB: 35, runtimeStorageGiB: 25 }),
  ]))
  await user.click(screen.getByRole("button", { name: "Edit dev-copy" }))
  expect(screen.getByRole("spinbutton", { name: "CPUs custom (CPUs)" })).toHaveValue(3)
  expect(screen.getByRole("spinbutton", { name: "Workspace disk custom (GiB)" })).toHaveValue(35)
})


it("blocks duplicate names and invalid VM resource ranges", async () => {
  const { user, saveMachineConfiguration } = await renderMachineScenario()
  await user.click(screen.getByRole("button", { name: "Duplicate settings for dev" }))
  await user.clear(screen.getByRole("textbox", { name: "Sandbox name" }))
  await user.type(screen.getByRole("textbox", { name: "Sandbox name" }), "personal")
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs" }), "12")
  await user.selectOptions(screen.getByRole("combobox", { name: "CPUs ceiling" }), "4")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(screen.getByText("Sandbox names must be unique.")).toBeVisible()
  expect(screen.getByText("CPU limit cannot exceed its ceiling.")).toBeVisible()
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
})


it("reports the machine capacity in the draft instead of throwing across the action boundary", async () => {
  const source = {
    ...onboardingScenarios.running,
    machineConfigurations: Array.from({ length: 64 }, (_, index) => ({
      ...onboardingScenarios.running.machineConfigurations[0],
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `machine-${index + 1}`,
    })),
  }
  const saveMachineConfiguration = vi.fn()
  const user = userEvent.setup()
  render(<OnboardingPreview source={source} actions={{
    saveMachineConfiguration,
    retryWorkspaceSetup: vi.fn(),
    finishSetup: vi.fn(),
  }} />)
  await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "New sandbox" }))
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(screen.getByRole("alert")).toHaveTextContent("Configure no more than 64 sandboxes.")
  expect(saveMachineConfiguration).not.toHaveBeenCalled()
}, 15_000)
 // Rendering and editing the maximum 64 cards is slower on Linux CI.

it("mirrors final machine order and kind in Review while preserving activity collapse", async () => {
  const { user } = await renderMachineScenario()
  await user.click(screen.getByRole("button", { name: "Add" }))
  await user.click(screen.getByRole("menuitem", { name: "Connect an SSH host…" }))
  await user.clear(screen.getByRole("textbox", { name: "SSH host name" }))
  await user.type(screen.getByRole("textbox", { name: "SSH host name" }), "remote")
  await user.type(screen.getByRole("textbox", { name: "SSH host" }), "remote.example.com")
  await user.type(screen.getByRole("textbox", { name: "SSH user" }), "ops")
  await user.click(screen.getByRole("button", { name: "Save" }))
  await user.click(screen.getByRole("button", { name: "Reorder remote" }))
  await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}")

  await user.click(screen.getByRole("button", { name: "Expand activity" }))
  expect(screen.getByLabelText("Sandbox activity")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Collapse activity" }))
  expect(screen.queryByLabelText("Sandbox activity")).not.toBeInTheDocument()
  expect(screen.getByTestId("machine-list")).toBeVisible()

  await user.click(screen.getByRole("tab", { name: /Review/ }))
  const review = screen.getByRole("list", { name: "Sandboxes" })
  const rows = within(review).getAllByRole("listitem")
  const expected = [
    ["remote", "SSH host", "ops@remote.example.com:22"],
    ["dev", "vm", "CPUs: 8 · Memory: 32 GiB"],
    ["playgrounds", "vm", "CPUs: 4 · Memory: 32 GiB"],
    ["personal", "vm", "CPUs: 6 · Memory: 16 GiB"],
  ]
  expect(rows).toHaveLength(expected.length)
  expected.forEach(([name, kind, detail], index) => {
    expect(within(rows[index]).getByText(name)).toBeVisible()
    expect(within(rows[index]).getByText(kind)).toBeVisible()
    expect(rows[index]).toHaveTextContent(detail)
  })
  await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
  expect(screen.getByRole("button", { name: "Expand activity" })).toHaveAttribute("aria-expanded", "false")
  expect(within(screen.getByRole("tabpanel")).queryByLabelText("Sandbox activity")).not.toBeInTheDocument()
}, 15_000)

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { WorkspaceBadge } from "./application-ui"
import type { WorkspaceState } from "@/features/application/model/application-source"

const office = { id: "office", name: "Office Mac", address: "office.local", connected: true, vmId: "remote-dev" }

it("names a remote sandbox's computer inline so same-named sandboxes differ at a glance", () => {
  render(<><WorkspaceBadge name="dev" state="running" /><WorkspaceBadge name="dev" state="running" computer={office} /></>)
  const local = screen.getByLabelText("dev, Running")
  const remote = screen.getByLabelText("dev, Running, on Office Mac")
  expect(local).toHaveTextContent(/^dev$/)
  expect(remote).toHaveTextContent("dev · Office Mac")
})

it("states the sandbox state and computer in its tooltip", async () => {
  const user = userEvent.setup()
  render(<WorkspaceBadge name="dev" state="stopped" />)
  await user.hover(screen.getByLabelText("dev, Stopped"))
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Stopped on this computer")
})

it("gives every state its own shape, not just its own color", () => {
  const states: WorkspaceState[] = ["running", "starting", "stopped", "failed"]
  render(<>{states.map(state => <WorkspaceBadge key={state} name={state} state={state} />)}</>)
  const shapes = states.map(state => document.querySelector(`[data-workspace-state-dot="${state}"]`)?.getAttribute("data-workspace-state-shape"))
  expect(shapes).toEqual(["circle", "triangle", "square", "cross"])
})

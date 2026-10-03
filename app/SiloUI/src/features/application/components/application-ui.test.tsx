import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"

import { ComputerBadge } from "./application-ui"
import type { ComputerState } from "@/features/application/model/application-source"

const office = { id: "office", name: "Office Mac", address: "office.local", connected: true, computerId: "remote-dev" }

it.each<ComputerState>(["running", "starting", "stopped", "failed"])("exposes a named, focusable computer status group for %s", async (state) => {
  const user = userEvent.setup()
  render(<ComputerBadge name="dev" state={state} device={office} />)
  const label = `dev, ${state.charAt(0).toUpperCase() + state.slice(1)}, on Office Mac`
  const badge = screen.getByRole("group", { name: label })
  await user.tab()
  expect(badge).toHaveFocus()
})

it("names a remote computer's device inline so same-named computers differ at a glance", () => {
  render(<><ComputerBadge name="dev" state="running" /><ComputerBadge name="dev" state="running" device={office} /></>)
  const local = screen.getByLabelText("dev, Running")
  const remote = screen.getByLabelText("dev, Running, on Office Mac")
  expect(local).toHaveTextContent(/^dev$/)
  expect(remote).toHaveTextContent("dev · Office Mac")
})

it("states the computer state and device in its tooltip", async () => {
  const user = userEvent.setup()
  render(<ComputerBadge name="dev" state="stopped" />)
  await user.hover(screen.getByLabelText("dev, Stopped"))
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Stopped on this device")
})

it("gives every state its own shape, not just its own color", () => {
  const states: ComputerState[] = ["running", "starting", "stopped", "failed"]
  render(<>{states.map(state => <ComputerBadge key={state} name={state} state={state} />)}</>)
  const shapes = states.map(state => document.querySelector(`[data-computer-state-dot="${state}"]`)?.getAttribute("data-computer-state-shape"))
  expect(shapes).toEqual(["circle", "triangle", "square", "cross"])
})

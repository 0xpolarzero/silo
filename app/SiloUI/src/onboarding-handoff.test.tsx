import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { FixtureApp } from "./fixtures/fixture-app"

const originalURL = window.location.href
afterEach(() => window.history.replaceState(null, "", originalURL))

describe("onboarding to application", () => {
  it("finishes default onboarding, exposes permissions, and opens Silo with saved preferences", async () => {
    window.history.replaceState(null, "", "?view=onboarding")
    const user = userEvent.setup()
    render(<FixtureApp />)
    await user.click(screen.getByRole("combobox", { name: "Browser" }))
    await user.click(screen.getByRole("option", { name: "Firefox" }))
    await user.click(screen.getByRole("tab", { name: /Sandboxes/ }))
    await user.click(screen.getByRole("button", { name: "Edit dev" }))
    await user.clear(screen.getByRole("textbox", { name: "Machine name" }))
    await user.type(screen.getByRole("textbox", { name: "Machine name" }), "build")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await user.click(screen.getByRole("tab", { name: /Review/ }))
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Finish" }))
    expect(screen.getByRole("switch", { name: "Launch Silo at login" })).toBeVisible()
    expect(screen.getByRole("switch", { name: "Enable notifications" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(screen.queryByRole("navigation", { name: "Setup steps" })).not.toBeInTheDocument()
    const navigation = within(screen.getByRole("navigation", { name: "Silo navigation" }))
    const list = within(screen.getByRole("list", { name: "Configured sandboxes" }))
    expect(list.getByText("build", { exact: true })).toBeVisible()
    expect(list.queryByText("dev", { exact: true })).not.toBeInTheDocument()
    await user.click(navigation.getByRole("button", { name: "Settings" }))
    expect(screen.getByRole("combobox", { name: "Browser" })).toHaveTextContent("Firefox")
    await user.click(navigation.getByRole("button", { name: "Backup" }))
    expect(screen.getByText("No backups yet")).toBeVisible()
    expect(screen.getByRole("button", { name: "Back up" })).toBeDisabled()
    expect(new URL(window.location.href).searchParams.get("view")).toBe("app")
  })
})

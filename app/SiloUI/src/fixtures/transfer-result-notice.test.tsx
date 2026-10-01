import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { afterEach, describe, expect, it } from "vitest"

import { FixtureApp } from "./fixture-app"
import { createFixtureUnseenResult, unseenResultFixtureModeFromSearch, unseenResultFixtureModes } from "./transfer-result-notice"

afterEach(() => { toast.dismiss(); window.history.replaceState(null, "", "/") })

describe("unseen result fixtures", () => {
  it("parses every mode from the URL and ignores anything else", () => {
    for (const mode of unseenResultFixtureModes) expect(unseenResultFixtureModeFromSearch(`?unseen-result=${mode}`)).toBe(mode)
    expect(unseenResultFixtureModeFromSearch("?unseen-result=unknown")).toBeUndefined()
    expect(unseenResultFixtureModeFromSearch("")).toBeUndefined()
  })

  it("shares one result between the screen about the backup and the application, and acknowledging it ends it for both", async () => {
    const result = createFixtureUnseenResult("interrupted-export")
    expect(result.current().unseen).toBe(true)
    await expect(result.read()).resolves.toMatchObject({ id: "fixture-interrupted-export", title: "Export interrupted before the upgrade" })
    let changed = 0
    await result.subscribe(() => { changed += 1 })
    // Another result is not this one: acknowledging it leaves this one unseen.
    await result.acknowledge("another")
    expect(result.current().unseen).toBe(true)
    await result.acknowledge("fixture-interrupted-export")
    expect(result.current().unseen).toBe(false)
    expect(changed).toBe(1)
    await expect(result.read()).resolves.toBeNull()
  })
})

describe("unseen result previews", () => {
  it("shows an interrupted import after an upgrade on the screen about the backup, then opens the application without showing it again", async () => {
    window.history.replaceState(null, "", "?view=migration&unseen-result=interrupted-import")
    const user = userEvent.setup()
    render(<FixtureApp />)
    expect(await screen.findByRole("region", { name: "Import interrupted before the upgrade" })).toHaveTextContent("Import the file again.")
    await user.click(screen.getByRole("button", { name: "Open Silo" }))
    expect(await screen.findByRole("navigation", { name: "Silo navigation" })).toBeVisible()
    expect(screen.queryByText("Import interrupted before the upgrade")).not.toBeInTheDocument()
  })

  it("shows an unseen set-aside notice as an export and import notification when the screen about the backup is not shown", async () => {
    window.history.replaceState(null, "", "?view=app&unseen-result=set-aside")
    render(<FixtureApp />)
    expect(await screen.findByText("Export or import record set aside")).toBeVisible()
    expect(screen.getByText("An export or import record couldn’t be read and was set aside.")).toBeVisible()
  })

  it("shows nothing about an old result without the parameter", async () => {
    window.history.replaceState(null, "", "?view=app")
    render(<FixtureApp />)
    expect(await screen.findByRole("navigation", { name: "Silo navigation" })).toBeVisible()
    expect(screen.queryByText("Export or import record set aside")).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { SecretEditor } from "./secret-editor"

describe("SecretEditor current access settings", () => {
  it.each(["domains", "computers"])("requires reloading changed %s before saving a replacement value", (field) => {
    const source = structuredClone(applicationSourceForScenario("running"))
    const secret = source.secrets[0]
    const save = vi.fn()
    const props = { source, onSave: save, onCancel: vi.fn() }
    const { rerender } = render(<SecretEditor secret={secret} {...props} />)
    fireEvent.change(screen.getByLabelText("Replacement value"), { target: { value: "replacement-fixture" } })
    const current = { ...secret, ...(field === "domains" ? { allowedDomains: ["new.example.test"] } : { computers: ["playgrounds"] }) }
    const currentSource = { ...source, secrets: [current] }
    rerender(<SecretEditor secret={current} {...props} source={currentSource} />)

    fireEvent.submit(screen.getByRole("form"))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("This secret changed while you were editing.")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }))
    expect(screen.getByLabelText("Replacement value")).toHaveValue("replacement-fixture")
    expect(screen.getByRole("textbox", { name: "Allowed domains" })).toHaveValue(current.allowedDomains.join(", "))
    fireEvent.submit(screen.getByRole("form"))
    expect(save).toHaveBeenCalledExactlyOnceWith({ operation: "edit", id: current.id, name: current.name, value: "replacement-fixture", computers: current.computers, allowedDomains: current.allowedDomains })
  })

  it("preserves the draft when only runtime application status changes", () => {
    const source = structuredClone(applicationSourceForScenario("running"))
    const secret = source.secrets[0]
    const save = vi.fn()
    const props = { source, onSave: save, onCancel: vi.fn() }
    const { rerender } = render(<SecretEditor secret={secret} {...props} />)
    fireEvent.change(screen.getByLabelText("Replacement value"), { target: { value: "replacement-fixture" } })
    rerender(<SecretEditor secret={{ ...secret, state: "restart-required" }} {...props} />)
    expect(screen.queryByRole("button", { name: "Reload settings" })).not.toBeInTheDocument()
    fireEvent.submit(screen.getByRole("form"))
    expect(save).toHaveBeenCalledOnce()
  })
})

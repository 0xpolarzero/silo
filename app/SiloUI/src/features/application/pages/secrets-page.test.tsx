import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SecretsPage } from "@/features/application/pages/secrets-page"
import { useApplicationFixture } from "@/fixtures/application-state"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"

function SecretsPreview({ source }: { source: ApplicationSource }) {
  const fixture = useApplicationFixture(source)
  return <SecretsPage source={fixture.source} onRemoveSecret={fixture.removeSecret} />
}

describe("SecretsPage", () => {
  it("requests removal after confirmation and waits for the source to publish the change", async () => {
    const user = userEvent.setup()
    const source = applicationSourceForScenario("running")
    const onRemoveSecret = vi.fn()
    const { rerender } = render(<SecretsPage source={source} onRemoveSecret={onRemoveSecret} />)
    await user.click(screen.getByRole("button", { name: "Remove PACKAGE_TOKEN" }))
    expect(onRemoveSecret).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" }))
    expect(onRemoveSecret).toHaveBeenCalledExactlyOnceWith("package-token")
    expect(screen.getByText("PACKAGE_TOKEN")).toBeVisible()

    rerender(<SecretsPage source={{ ...source, secrets: source.secrets.filter(({ id }) => id !== "package-token") }} onRemoveSecret={onRemoveSecret} />)
    expect(screen.queryByText("PACKAGE_TOKEN")).not.toBeInTheDocument()
  })

  it("requires confirmation and lets Escape or an outside click cancel removal", async () => {
    const user = userEvent.setup()
    render(<SecretsPreview source={applicationSourceForScenario("running")} />)
    const list = within(screen.getByRole("list", { name: "Configured secrets" }))

    await user.click(list.getByRole("button", { name: "Remove PACKAGE_TOKEN" }))
    expect(list.getAllByRole("listitem")).toHaveLength(2)
    expect(list.getByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" })).toBeVisible()

    await user.keyboard("{Escape}")
    expect(list.queryByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" })).not.toBeInTheDocument()
    await user.click(list.getByRole("button", { name: "Remove PACKAGE_TOKEN" }))
    await user.click(screen.getByRole("heading", { name: "Secrets" }))
    expect(list.queryByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" })).not.toBeInTheDocument()
    expect(list.getAllByRole("listitem")).toHaveLength(2)

    await user.click(list.getByRole("button", { name: "Remove PACKAGE_TOKEN" }))
    await user.click(list.getByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" }))
    expect(list.queryByText("PACKAGE_TOKEN")).not.toBeInTheDocument()
    expect(list.getByText("DATABASE_URL")).toBeVisible()
    expect(list.getByText("Restart to apply")).toBeVisible()
    expect(screen.getByText("1 configured")).toBeVisible()

    await user.click(list.getByRole("button", { name: "Remove DATABASE_URL" }))
    await user.click(list.getByRole("button", { name: "Confirm removal of DATABASE_URL" }))
    expect(screen.getByText("No secrets configured.")).toBeVisible()
    expect(screen.getByText("0 configured")).toBeVisible()
    expect(screen.getByRole("button", { name: "Add secret" })).toBeVisible()
  })

  it("replaces preview removals and pending confirmation when the source changes", async () => {
    const user = userEvent.setup()
    const source = applicationSourceForScenario("running")
    const { rerender } = render(<SecretsPreview source={source} />)
    await user.click(screen.getByRole("button", { name: "Remove PACKAGE_TOKEN" }))
    await user.click(screen.getByRole("button", { name: "Confirm removal of PACKAGE_TOKEN" }))
    await user.click(screen.getByRole("button", { name: "Remove DATABASE_URL" }))

    rerender(<SecretsPreview source={{ ...source, secrets: [...source.secrets] }} />)
    expect(screen.getByText("2 configured")).toBeVisible()
    expect(screen.getByRole("button", { name: "Remove PACKAGE_TOKEN" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Confirm removal of DATABASE_URL" })).not.toBeInTheDocument()
  })
})

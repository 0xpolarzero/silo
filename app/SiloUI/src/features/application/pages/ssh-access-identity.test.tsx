import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationWorkspace, SshAccessWorkspace } from "../model/application-source"
import { SshAccessPanel } from "./ssh-access-panel"

const access: SshAccessWorkspace = { workspace: "dev", enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: [], state: "listening", message: null, fingerprint: "SHA256:fixture", computerName: "Fixture computer", addresses: ["127.0.0.1"] }
afterEach(() => { toast.dismiss(); vi.restoreAllMocks() })

describe("SSH row sandbox identity", () => {
  it("does not retry an old settings save on a same-named replacement", async () => {
    const user = userEvent.setup()
    const workspace = structuredClone(applicationSourceForScenario("running").workspaces[0])
    const save = vi.fn().mockRejectedValueOnce(new Error("Could not save")).mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveSshAccess: save })
    const page = (current: ApplicationWorkspace) => <><Toaster /><SshAccessPanel workspaces={[current]} state={{ workspaces: [access] }} actions={actions} active={false} /></>
    const view = render(page(workspace))
    await user.click(screen.getByRole("button", { name: "SSH access controls for dev" }))
    await user.click(screen.getByRole("switch", { name: "Allow SSH from Fixture computer" }))
    const retry = await screen.findByRole("button", { name: "Retry" })
    view.rerender(page({ ...workspace, machine: { ...workspace.machine, id: "replacement-id" } }))
    await user.click(retry)
    expect(save).toHaveBeenCalledOnce()
  })

  it("does not copy a late SSH command after a same-named replacement appears", async () => {
    const user = userEvent.setup()
    const workspace = structuredClone(applicationSourceForScenario("running").workspaces[0])
    let finish!: (value: string) => void
    const connection = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ sshConnection: connection, saveSshAccess: vi.fn() })
    const page = (current: ApplicationWorkspace) => <SshAccessPanel workspaces={[current]} state={{ workspaces: [access] }} actions={actions} active={false} />
    const view = render(page(workspace))
    await user.click(screen.getByRole("button", { name: "SSH access controls for dev" }))
    await user.click(screen.getByRole("button", { name: "More local SSH actions" }))
    await user.click(screen.getByRole("menuitem", { name: "Copy local SSH command" }))
    expect(connection).toHaveBeenCalledOnce()
    view.rerender(page({ ...workspace, machine: { ...workspace.machine, id: "replacement-id" } }))
    await act(async () => finish("ssh fixture-old-sandbox"))
    expect(write).not.toHaveBeenCalled()
  })
})

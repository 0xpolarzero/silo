import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { Toaster } from "@/components/ui/sonner"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createApplicationActionsMock } from "@/test/application-actions"
import type { ApplicationComputer, SshAccessComputer } from "../model/application-source"
import { SshAccessPanel } from "./ssh-access-panel"

const access: SshAccessComputer = { computer: "dev", enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: [], state: "listening", message: null, fingerprint: "SHA256:fixture", deviceName: "Fixture device", addresses: ["127.0.0.1"] }
afterEach(() => { toast.dismiss(); vi.restoreAllMocks() })

describe("SSH row computer identity", () => {
  it("does not retry an old settings save on a same-named replacement", async () => {
    const user = userEvent.setup()
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    const save = vi.fn().mockRejectedValueOnce(new Error("Could not save")).mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ saveSshAccess: save })
    const page = (current: ApplicationComputer) => <><Toaster /><SshAccessPanel computers={[current]} state={{ computers: [access] }} actions={actions} active={false} /></>
    const view = render(page(computer))
    await user.click(screen.getByRole("button", { name: "SSH access controls for dev" }))
    await user.click(screen.getByRole("switch", { name: "Allow SSH from Fixture device" }))
    const retry = await screen.findByRole("button", { name: "Retry" })
    view.rerender(page({ ...computer, configuration: { ...computer.configuration, id: "replacement-id" } }))
    await user.click(retry)
    expect(save).toHaveBeenCalledOnce()
  })

  it("does not copy a late SSH command after a same-named replacement appears", async () => {
    const user = userEvent.setup()
    const computer = structuredClone(applicationSourceForScenario("running").computers[0])
    let finish!: (value: string) => void
    const connection = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    const actions = createApplicationActionsMock({ sshConnection: connection, saveSshAccess: vi.fn() })
    const page = (current: ApplicationComputer) => <SshAccessPanel computers={[current]} state={{ computers: [access] }} actions={actions} active={false} />
    const view = render(page(computer))
    await user.click(screen.getByRole("button", { name: "SSH access controls for dev" }))
    await user.click(screen.getByRole("button", { name: "More local SSH actions" }))
    await user.click(screen.getByRole("menuitem", { name: "Copy local SSH command" }))
    expect(connection).toHaveBeenCalledOnce()
    view.rerender(page({ ...computer, configuration: { ...computer.configuration, id: "replacement-id" } }))
    await act(async () => finish("ssh fixture-old-computer"))
    expect(write).not.toHaveBeenCalled()
  })
})

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { SshAccessPanel } from "./ssh-access-panel"
import type { ApplicationActions, ApplicationWorkspace, SshAccessWorkspace } from "../model/application-source"
const workspace = applicationSourceForScenario("complete").workspaces[0]
const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOV89nMlTnLLFa2UlVuqssPU56E2EbdIg1XmcraGpVXQ laptop"
const base: SshAccessWorkspace = { workspace: "dev", enabled: true, port: 2222, bindAddress: "127.0.0.1", keys: [publicKey], state: "listening", message: null, fingerprint: "SHA256:example", computerName: "Ada’s Mac mini", addresses: ["127.0.0.1", "192.168.1.42"] }
function setup(patch: Partial<SshAccessWorkspace> = {}, save = vi.fn().mockResolvedValue(undefined), error?: string, displayedWorkspace: ApplicationWorkspace = workspace) {
  const access = { ...base, ...patch }
  const actions = { sshConnection: vi.fn().mockImplementation((_workspace: string, download: boolean) => Promise.resolve(download ? null : "ssh -i '/managed/client_key' -p 2222 root@127.0.0.1")), saveSshAccess: save, refreshSshAccess: vi.fn().mockResolvedValue(undefined) } as unknown as ApplicationActions
  const view = render(<SshAccessPanel workspaces={[displayedWorkspace]} state={{ workspaces: [access] }} error={error} actions={actions} active />)
  return { user: userEvent.setup(), access, save, actions, ...view }
}
async function expand(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole("button", { name: "SSH controls for dev" })) }
async function selectAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: name.includes("network") ? "More network SSH actions" : "More local SSH actions" }))
  await user.click(screen.getByRole("menuitem", { name }))
}
describe("managed SSH access", () => {
  it("clears command copy feedback after a short delay", async () => {
    const { user } = setup()
    await expand(user)
    await selectAction(user, "Copy local SSH command")
    await user.click(screen.getByRole("button", { name: "More local SSH actions" }))
    expect(screen.getByRole("menuitem", { name: "Copy local SSH command" })).toHaveTextContent("Command copied")
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy local SSH command" })).toHaveTextContent("Copy terminal command"), { timeout: 2500 })
  })
  it("shows two toggles and a ready connection without key setup or advanced settings", async () => {
    const { user, actions } = setup({ keys: [] })
    expect(screen.getByText("SSH listening")).toBeVisible()
    await expand(user)
    expect(screen.getAllByRole("switch")).toHaveLength(2)
    expect(screen.getByText("User:")).toHaveTextContent("User: root")
    expect(screen.getByRole("switch", { name: "Allow SSH from Ada’s Mac mini" })).toBeChecked()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument()
    expect(screen.queryByText(/Keys \(/)).not.toBeInTheDocument()
    await selectAction(user, "Copy local SSH command")
    expect(actions.sshConnection).toHaveBeenCalledWith("dev", false, false)
    expect(await navigator.clipboard.readText()).toBe("ssh -i '/managed/client_key' -p 2222 root@127.0.0.1")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    await expand(user)
    expect(screen.getByText("SSH listening")).toBeVisible()
  })
  it("only changes access when the switch itself is clicked", async () => {
    const { user, save } = setup()
    await expand(user)
    await user.click(screen.getByText("Allow SSH from Ada’s Mac mini"))
    await user.click(screen.getByText("Allow SSH from other computers"))
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole("switch", { name: "Allow SSH from Ada’s Mac mini" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })
  it("downloads the generated key through the native save action", async () => {
    const { user, actions } = setup()
    await expand(user)
    await selectAction(user, "Save local SSH key file")
    expect(actions.sshConnection).toHaveBeenCalledWith("dev", true, false)
    expect(await navigator.clipboard.readText()).toBe("")
  })
  it.each([
    ["Copy SSH address", "Copy address"],
    ["More local SSH actions", "More local SSH actions"],
  ])("uses the app tooltip for %s without native titles", async (name, caption) => {
    const { user, container } = setup()
    await expand(user)
    await user.hover(screen.getByRole("button", { name }))
    expect(await screen.findByRole("tooltip")).toHaveTextContent(caption)
    expect(container.querySelector("[title]")).toBeNull()
  })
  it("copies the displayed network address and keeps the fingerprint in its tooltip", async () => {
    const { user } = setup({ bindAddress: "192.168.1.42" })
    await expand(user)
    await user.click(screen.getByRole("button", { name: "Copy network SSH address" }))
    expect(await navigator.clipboard.readText()).toBe("192.168.1.42:2222")
    await user.hover(screen.getByText("192.168.1.42:2222"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Host key: SHA256:example")
  })
  it("groups each address with its toggle and provides network editing and endpoint-specific commands", async () => {
    const { user, actions } = setup({ bindAddress: "192.168.1.42" })
    await expand(user)
    const local = within(screen.getByRole("group", { name: "Allow SSH from Ada’s Mac mini" }))
    const network = within(screen.getByRole("group", { name: "Allow SSH from other computers" }))
    expect(local.getByText("127.0.0.1:2222")).toBeVisible()
    expect(network.getByText("192.168.1.42:2222")).toBeVisible()
    await selectAction(user, "Copy local SSH command")
    expect(actions.sshConnection).toHaveBeenLastCalledWith("dev", false, false)
    await selectAction(user, "Copy network SSH command")
    expect(actions.sshConnection).toHaveBeenLastCalledWith("dev", false, true)
    await selectAction(user, "Edit network connection")
    expect(screen.getByRole("combobox", { name: "LAN or VPN address" })).toHaveValue("192.168.1.42")
  })
  it("enables a stopped sandbox without key setup or a start action", async () => {
    const { user, save } = setup({ enabled: false, state: "disabled", keys: [] })
    await expand(user)
    expect(screen.getByRole("switch", { name: "Allow SSH from other computers" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Copy local SSH command" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("switch", { name: "Allow SSH from Ada’s Mac mini" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, keys: [] }))
  })
  it("omits the redundant waiting caption", async () => {
    const { user } = setup({ state: "waiting" })
    await expand(user)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
  it("enables the single available network address directly", async () => {
    const { user, save } = setup()
    await expand(user)
    await user.click(screen.getByRole("switch", { name: "Allow SSH from other computers" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ bindAddress: "192.168.1.42", keys: [publicKey] }))
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })
  it("asks for an address when there are multiple interfaces and can cancel", async () => {
    const { user, save } = setup({ addresses: [...base.addresses, "10.77.77.2"] })
    await expand(user)
    await user.click(screen.getByRole("switch", { name: "Allow SSH from other computers" }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox", { name: "LAN or VPN address" })).toHaveValue("192.168.1.42")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Allow SSH from other computers" })).not.toBeChecked()
  })
  it("rejects wildcard addresses and saves a selected interface", async () => {
    const { user, save } = setup({ addresses: [...base.addresses, "10.77.77.2"] })
    await expand(user)
    await user.click(screen.getByRole("switch", { name: "Allow SSH from other computers" }))
    const address = screen.getByRole("combobox", { name: "LAN or VPN address" })
    await user.clear(address); await user.type(address, "0.0.0.0")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("specific LAN or VPN IPv4")
    await user.clear(address); await user.type(address, "10.77.77.2")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ bindAddress: "10.77.77.2" }))
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })
  it("disables network access while retaining keys and local access", async () => {
    const { user, save } = setup({ bindAddress: "192.168.1.42" })
    await expand(user)
    await user.click(screen.getByRole("switch", { name: "Allow SSH from other computers" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bindAddress: "127.0.0.1", keys: [publicKey] }))
  })
  it("edits and validates the port beside the connection", async () => {
    const { user, save } = setup()
    await expand(user)
    await selectAction(user, "Edit connection")
    const port = screen.getByRole("spinbutton", { name: "SSH port" })
    await user.clear(port); await user.type(port, "65536")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a port from 1 to 65535")
    await user.clear(port); await user.type(port, "2223")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ port: 2223, keys: [publicKey] }))
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
  })
  it("preserves a failed port edit and displays its error", async () => {
    const { user } = setup({}, vi.fn().mockRejectedValue(new Error("Port is in use.")))
    await expand(user)
    await selectAction(user, "Edit connection")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Port is in use")
    expect(screen.getByRole("spinbutton")).toBeVisible()
  })
  it("reports connection preparation failures without copying an unusable command", async () => {
    const { user, actions } = setup()
    vi.mocked(actions.sshConnection!).mockRejectedValue(new Error("Enable access from other computers first."))
    await expand(user)
    await selectAction(user, "Copy local SSH command")
    expect(screen.getByRole("alert")).toHaveTextContent("Enable access from other computers first")
    expect(await navigator.clipboard.readText()).toBe("")
  })
  it("prevents concurrent changes while preparing the connection", async () => {
    const { user, actions } = setup()
    let resolve: (value: string | null) => void = () => {}
    vi.mocked(actions.sshConnection!).mockImplementation(() => new Promise(done => { resolve = done }))
    await expand(user)
    await selectAction(user, "Copy local SSH command")
    await user.click(screen.getByRole("button", { name: "More local SSH actions" }))
    expect(screen.getByRole("menuitem", { name: "Save local SSH key file" })).toHaveAttribute("data-disabled")
    resolve(null)
    expect(await screen.findByRole("menuitem", { name: "Copy local SSH command" })).toBeVisible()
  })
  it("reports a clipboard failure instead of claiming a copied connection", async () => {
    const { user } = setup()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable."))
    await expand(user)
    await selectAction(user, "Copy local SSH command")
    expect(screen.getByRole("alert")).toHaveTextContent("Clipboard unavailable")
    expect(screen.queryByRole("button", { name: "Local SSH command copied" })).not.toBeInTheDocument()
  })
  it("routes connection preparation and changes to the remote owner", async () => {
    const target = "silo-remote:office:vm-immutable-id"
    const remote = { ...workspace, computer: { id: "office", vmId: "vm-immutable-id", name: "Office Mac", address: "user@office", connected: true } }
    const { user, actions, save } = setup({ workspace: target, computerName: "Office Mac", bindAddress: "192.168.1.42" }, undefined, undefined, remote)
    await expand(user)
    expect(screen.getByRole("switch", { name: "Allow SSH from Office Mac" })).toBeChecked()
    await selectAction(user, "Copy network SSH command")
    expect(actions.sshConnection).toHaveBeenCalledWith(target, false, true)
    await user.click(screen.getByRole("switch", { name: "Allow SSH from Office Mac" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ workspace: target, enabled: false, keys: [publicKey] }))
  })
  it("disables stale remote connections and changes", async () => {
    const remote = { ...workspace, computer: { id: "office", vmId: "vm-immutable-id", name: "Office Mac", address: "user@office", connected: true } }
    const { user } = setup({ workspace: "silo-remote:office:vm-immutable-id", computerName: "Office Mac", unavailable: "SSH status on Office Mac is unavailable." }, undefined, undefined, remote)
    await expand(user)
    expect(screen.getByText("SSH status unavailable")).toBeVisible()
    expect(screen.getByRole("switch", { name: "Allow SSH from Office Mac" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "More local SSH actions" }))
    expect(screen.getByRole("menuitem", { name: "Copy local SSH command" })).toHaveAttribute("data-disabled")
    expect(screen.getByRole("menuitem", { name: "Save local SSH key file" })).toHaveAttribute("data-disabled")
    expect(screen.getByRole("menuitem", { name: "Edit connection" })).toHaveAttribute("data-disabled")
  })
  it("keeps healthy remote controls writable when local status fails", async () => {
    const remote = { ...workspace, computer: { id: "office", vmId: "vm-immutable-id", name: "Office Mac", address: "user@office", connected: true } }
    const { user } = setup({ workspace: "silo-remote:office:vm-immutable-id", computerName: "Office Mac" }, undefined, "Could not check SSH access.", remote)
    await expand(user)
    expect(screen.getByRole("switch", { name: "Allow SSH from Office Mac" })).toBeEnabled()
  })
  it("does not present stale local state as listening or allow changes", async () => {
    const { user } = setup({}, undefined, "Could not check SSH access.")
    expect(screen.getByText("SSH status unavailable")).toBeVisible()
    expect(screen.queryByText("SSH listening")).not.toBeInTheDocument()
    await expand(user)
    expect(screen.getByRole("switch", { name: "Allow SSH from Ada’s Mac mini" })).toBeDisabled()
  })
})

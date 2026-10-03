import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { NetworkPage } from "./network-page"
import { remoteWorkspaceTarget } from "../model/connections"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, NetworkState } from "../model/application-source"
afterEach(() => { toast.dismiss() })
const workspaces = [applicationSourceForScenario("complete").workspaces[0]]
const network: NetworkState = {workspaces:[{workspace:"dev",error:null,ports:[
  {port:3000,hostPort:43000,scheme:"http",state:"reachable",configured:true},
  {port:5432,hostPort:45432,scheme:null,state:"reachable",configured:true},
  {port:8080,hostPort:null,scheme:null,state:"unpublished",configured:false},
]}]}
function setup(overrides: Partial<ApplicationActions> = {}, state: NetworkState | undefined = network, browser = "Firefox") {
  const actions = { refreshNetwork: vi.fn(async () => {}), saveNetworkPort: vi.fn(async () => {}), removeNetworkPort: vi.fn(async () => {}), openNetworkPort: vi.fn(async () => {}), ...overrides } as unknown as ApplicationActions
  return {actions,user:userEvent.setup(),...render(<SettingsProvider initialSettings={{theme:"light"}}><Toaster /><NetworkPage workspaces={workspaces} browser={browser} network={state} actions={actions} active /></SettingsProvider>)}
}
describe("Network", () => {
  it.each(["Starting", "Stopping"])("describes a transitioning sandbox's ports as %s", detail => {
    const actions = { refreshNetwork: vi.fn(async () => {}) } as unknown as ApplicationActions
    render(<NetworkPage workspaces={workspaces.map(workspace => ({ ...workspace, state: "starting", stateDetail: detail }))}
      browser="Firefox" network={network} actions={actions} active={false} />)
    expect(screen.getAllByText(`Sandbox ${detail.toLowerCase()}`)).toHaveLength(3)
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument()
  })

  it("uses actual forwarded addresses and opens only reachable web services", async () => {
    const {user,actions} = setup()
    expect(screen.getByText("127.0.0.1:45432")).toBeVisible()
    expect(screen.queryByRole("button",{name:/Open .*45432/})).not.toBeInTheDocument()
    expect(screen.getByText("Not forwarded")).toBeVisible()
    await user.click(screen.getByRole("button",{name:"Open port 3000 in browser"}))
    expect(actions.openNetworkPort).toHaveBeenCalledWith("dev",3000)
    expect(screen.queryByText(/silo.test/)).not.toBeInTheDocument()
  })
  it.each(["Safari", "Google Chrome", "Firefox", "Unknown browser"])("shows sandbox website names and the 127.0.0.1 fallback with %s", async (browser) => {
    const named: NetworkState = { workspaces: [{ ...network.workspaces[0], host: "dev-1a2b3c4d.localhost" }] }
    const {user,actions} = setup({}, named, browser)
    expect(screen.getByText("http://dev-1a2b3c4d.localhost:43000")).toBeVisible()
    // Plain TCP services have no host name to separate; they stay at 127.0.0.1.
    expect(screen.getByText("127.0.0.1:45432")).toBeVisible()
    expect(screen.getAllByRole("button",{name:"Copy 127.0.0.1:45432"})).toHaveLength(1)
    await user.click(screen.getByRole("button",{name:"Copy http://dev-1a2b3c4d.localhost:43000"}))
    expect(await navigator.clipboard.readText()).toBe("http://dev-1a2b3c4d.localhost:43000")
    await user.click(screen.getByRole("button",{name:"Copy http://127.0.0.1:43000"}))
    expect(await navigator.clipboard.readText()).toBe("http://127.0.0.1:43000")
    await user.click(screen.getByRole("button",{name:"Open port 3000 in browser"}))
    expect(actions.openNetworkPort).toHaveBeenCalledWith("dev",3000)
  })
  it("adds an explicit mapping with automatic local port and preserves errors", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Local port is already in use.")).mockResolvedValueOnce(undefined)
    const {user} = setup({saveNetworkPort:save})
    await user.click(screen.getByRole("button",{name:"Add port"}))
    await user.type(screen.getByRole("spinbutton",{name:"Port"}),"9000")
    await user.selectOptions(screen.getByRole("combobox",{name:"Protocol"}),"tcp")
    await user.click(screen.getByRole("button",{name:"Add"}))
    expect(save).toHaveBeenCalledWith({workspace:"dev",port:9000,hostPort:null,scheme:null})
    expect(await screen.findByText("Local port is already in use.")).toBeVisible()
    expect(screen.getByText("Could not add port 9000 · dev")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("spinbutton",{name:"Port"})).toHaveValue(9000)
    await user.click(screen.getByRole("button",{name:"Retry"}))
    expect(await screen.findByText("Port 9000 added · dev")).toBeInTheDocument()
    expect(screen.queryByRole("spinbutton",{name:"Port"})).not.toBeInTheDocument()
  })

  it("keeps invalid port values in the form and explains each field before invoking native code", async () => {
    const {user, actions} = setup()
    await user.click(screen.getByRole("button", {name: "Add port"}))
    const guest = screen.getByRole("spinbutton", {name: "Port"})
    const local = screen.getByRole("spinbutton", {name: "Local port"})
    await user.type(guest, "65536")
    await user.type(local, "0")
    await user.click(screen.getByRole("button", {name: "Add"}))
    expect(actions.saveNetworkPort).not.toHaveBeenCalled()
    for (const field of [guest, local]) {
      expect(field).toHaveAttribute("aria-invalid", "true")
      expect(field).toHaveAccessibleDescription("Enter a port from 1 to 65535.")
    }
    expect(guest).toHaveValue(65536)
    expect(local).toHaveValue(0)
    await user.clear(guest)
    await user.type(guest, "9000")
    await user.clear(local)
    await user.click(screen.getByRole("button", {name: "Add"}))
    expect(actions.saveNetworkPort).toHaveBeenCalledWith({workspace: "dev", port: 9000, hostPort: null, scheme: "http"})
  })
  it("requires popover removal confirmation and Cancel closes it", async () => {
    const {user,actions} = setup()
    await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
    expect(screen.getByText("Remove port 3000?")).toBeVisible()
    expect(screen.getByText(/It stops forwarding to this (Mac|device)\./)).toBeVisible()
    expect(screen.getByRole("button",{name:"Cancel"})).toBeVisible()
    expect(actions.removeNetworkPort).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button",{name:"Cancel"}))
    await waitFor(() => expect(screen.queryByText("Remove port 3000?")).not.toBeInTheDocument())
    await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("Remove port 3000?")).not.toBeInTheDocument())
    expect(actions.removeNetworkPort).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
    await user.click(screen.getByRole("button",{name:"Remove"}))
    expect(actions.removeNetworkPort).toHaveBeenCalledWith("dev",3000)
  })
  it("keeps cached rows during refresh failure and disables browser actions", () => {
    const {rerender,actions} = setup()
    rerender(<NetworkPage workspaces={workspaces} browser="Firefox" network={network} error="Could not check network services." actions={actions} active />)
    expect(screen.getByText("http://127.0.0.1:43000")).toBeVisible()
    expect(screen.queryByRole("status",{name:"Loading network"})).not.toBeInTheDocument()
    expect(screen.queryByRole("button",{name:/^Open /})).not.toBeInTheDocument()
    expect(within(screen.getByRole("alert")).getByRole("button",{name:"Retry"})).toBeVisible()
  })
  it("shows mapping conflicts inline and never turns failed discovery into an empty result", () => {
    const {rerender,actions} = setup({}, {workspaces:[{workspace:"dev",error:null,ports:[{...network.workspaces[0].ports[0],state:"unknown",message:"Local port is already in use."}]}]})
    expect(screen.getByText("Local port is already in use.")).toBeVisible()
    expect(screen.queryByRole("button",{name:/^Open /})).not.toBeInTheDocument()
    rerender(<NetworkPage workspaces={workspaces} browser="Firefox" network={{workspaces:[{workspace:"dev",ports:[],error:"Could not check services."}]}} actions={actions} active />)
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check services.")
    expect(screen.queryByText("No ports")).not.toBeInTheDocument()
  })
  it.each(["running", "starting", "stopped", "failed"] as const)("does not present a cached %s VM state as current when its status is stale", state => {
    const actions = {refreshNetwork:vi.fn(async () => {}),openNetworkPort:vi.fn(async () => {})} as unknown as ApplicationActions
    render(<NetworkPage workspaces={workspaces.map(w => ({...w,state,freshness:"stale"}))} browser="Firefox" network={network} actions={actions} active />)
    expect(screen.queryByRole("button",{name:/^Open /})).not.toBeInTheDocument()
    expect(screen.getAllByText("Unknown")).toHaveLength(3)
  })
  it("shows skeletons only before the first result", async () => {
    const actions = {refreshNetwork:vi.fn(async () => {})} as unknown as ApplicationActions
    const {rerender} = render(<NetworkPage workspaces={workspaces} browser="Firefox" actions={actions} active />)
    expect(screen.getByRole("status",{name:"Loading network"})).toBeVisible()
    await act(async () => rerender(<NetworkPage workspaces={workspaces} browser="Firefox" actions={actions} network={network} active />))
    expect(screen.queryByRole("status",{name:"Loading network"})).not.toBeInTheDocument()
  })
})

it("forwards a detected port immediately without a form", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:/^Forward port 8080 to this (Mac|device)$/}))
  expect(await screen.findByText("Port 8080 forwarded · dev")).toBeVisible()
  expect(actions.saveNetworkPort).toHaveBeenCalledWith({workspace:"dev",port:8080,hostPort:null,scheme:"http"})
  expect(screen.queryByRole("spinbutton",{name:"Port"})).not.toBeInTheDocument()
})
it("edits protocol without fixing an automatic port and allows a local override", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:"Edit port 3000 from dev"}))
  expect(screen.getByRole("spinbutton",{name:"Port"})).toBeDisabled()
  expect(screen.getByRole("combobox",{name:"Sandbox"})).toBeDisabled()
  expect(screen.getByRole("spinbutton",{name:"Local port"})).toHaveValue(null)
  await user.selectOptions(screen.getByRole("combobox",{name:"Protocol"}),"https")
  await user.click(screen.getByRole("button",{name:"Save"}))
  expect(actions.saveNetworkPort).toHaveBeenLastCalledWith({workspace:"dev",port:3000,hostPort:null,scheme:"https"})
  await user.click(screen.getByRole("button",{name:"Edit port 3000 from dev"}))
  await user.type(screen.getByRole("spinbutton",{name:"Local port"}),"44000")
  await user.click(screen.getByRole("button",{name:"Save"}))
  expect(actions.saveNetworkPort).toHaveBeenLastCalledWith({workspace:"dev",port:3000,hostPort:44000,scheme:"http"})
})

it("preserves a saved local override and cancels edits without applying them", async () => {
  const {user,actions} = setup({}, {workspaces:[{workspace:"dev",error:null,ports:[{...network.workspaces[0].ports[0],configuredHostPort:43000}]}]})
  await user.click(screen.getByRole("button",{name:"Edit port 3000 from dev"}))
  expect(screen.getByRole("spinbutton",{name:"Local port"})).toHaveValue(43000)
  await user.selectOptions(screen.getByRole("combobox",{name:"Protocol"}),"tcp")
  await user.click(screen.getByRole("button",{name:"Cancel"}))
  expect(actions.saveNetworkPort).not.toHaveBeenCalled()
})

it("adds inside the table and replaces the edited row", async () => {
  const {user} = setup()
  await user.click(screen.getByRole("button",{name:"Add port"}))
  expect(within(screen.getByRole("table",{name:"Network"})).getByRole("row",{name:"New port"})).toBeVisible()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("row",{name:"New port"})).not.toBeInTheDocument()
  await user.click(screen.getByRole("button",{name:"Edit port 3000 from dev"}))
  expect(within(screen.getByRole("table",{name:"Network"})).getByRole("row",{name:"Edit port"})).toBeVisible()
  expect(screen.queryByText("http://127.0.0.1:43000")).not.toBeInTheDocument()
  await user.click(screen.getByRole("button",{name:"Cancel"}))
  expect(screen.getByText("http://127.0.0.1:43000")).toBeVisible()
})
it("closes the removal confirmation on one Escape after hovering its trigger", async () => {
  const {user,actions} = setup()
  const trigger = screen.getByRole("button",{name:"Remove port 3000 from dev"})
  await user.hover(trigger)
  await user.click(trigger)
  expect(screen.getByText("Remove port 3000?")).toBeVisible()
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByText("Remove port 3000?")).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
  expect(actions.removeNetworkPort).not.toHaveBeenCalled()
})
it("labels the removal confirmation in words and dismisses on outside click", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
  expect(screen.getByRole("button",{name:"Cancel"}).textContent).toBe("Cancel")
  expect(screen.getByRole("button",{name:"Remove"}).textContent).toBe("Remove")
  await user.click(screen.getByText("127.0.0.1:45432"))
  expect(screen.queryByRole("button",{name:"Remove"})).not.toBeInTheDocument()
  expect(actions.removeNetworkPort).not.toHaveBeenCalled()
})

describe("Network stopped sandboxes", () => {
  it("shows a stopped sandbox's saved ports as stopped rather than as an error", () => {
    const stopped = [{ ...workspaces[0], state: "stopped" as const }]
    const state: NetworkState = { workspaces: [{ workspace: "dev", error: "Could not inspect dev", ports: [{ port: 3000, hostPort: null, scheme: "http", state: "waiting", configured: true }] }] }
    const actions = { refreshNetwork: vi.fn(async () => {}) } as unknown as ApplicationActions
    render(<NetworkPage workspaces={stopped} browser="Firefox" network={state} actions={actions} active />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Sandbox stopped")).toBeVisible()
  })
})

it("disables adding ports with a tooltip while the sandbox is stopped", async () => {
  const stopped = [{...workspaces[0], state:"stopped" as const}]
  const actions = {refreshNetwork:vi.fn(async () => {}),saveNetworkPort:vi.fn(async () => {})} as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<NetworkPage workspaces={stopped} browser="Firefox" network={network} actions={actions} active />)
  expect(screen.getByRole("button",{name:"Add port"})).toBeDisabled()
  await user.hover(screen.getByRole("button",{name:"Add port"}).parentElement!)
  expect(await screen.findAllByText(`Start ${stopped[0].machine.name} to add ports`)).not.toHaveLength(0)
})


it.each(["local", "remote"])("isolates %s discovery errors from a healthy same-named sandbox on another device", async failing => {
  const local = workspaces[0]
  const target = remoteWorkspaceTarget("office", local.machine.id)
  const remote = { ...local, machine: { ...local.machine, id: target }, device: { id: "office", name: "Office Mac", address: "user@office", connected: true, vmId: local.machine.id } }
  const state: NetworkState = { workspaces: [
    { workspace: "dev", error: failing === "local" ? "Local discovery failed" : null, ports: [network.workspaces[0].ports[0]] },
    { workspace: target, error: failing === "remote" ? "Remote discovery failed" : null, ports: [{ ...network.workspaces[0].ports[0], hostPort: 44000 }] },
  ] }
  const actions = { refreshNetwork: vi.fn(async () => {}), openNetworkPort: vi.fn(async () => {}) } as unknown as ApplicationActions
  const user = userEvent.setup()
  render(<NetworkPage workspaces={[local, remote]} browser="Firefox" network={state} error={failing === "local" ? "Could not check network services." : null} actions={actions} active />)
  const healthy = screen.getByRole("row", { name: new RegExp(failing === "remote" ? "43000" : "44000") })
  const failed = screen.getByRole("row", { name: new RegExp(failing === "remote" ? "44000" : "43000") })
  expect(within(healthy).getByText("Reachable")).toBeVisible()
  expect(within(failed).getByText("Unknown")).toBeVisible()
  expect(within(failed).queryByRole("button", { name: "Open port 3000 in browser" })).not.toBeInTheDocument()
  await user.click(within(healthy).getByRole("button", { name: "Open port 3000 in browser" }))
  expect(actions.openNetworkPort).toHaveBeenCalledWith(failing === "remote" ? "dev" : target, 3000)
  if (failing === "remote") expect(screen.getByRole("alert")).toHaveTextContent("dev (Office Mac): Remote discovery failed")
})


it("blocks a previous failure's Retry while another port save is pending", async () => {
  let finish!: () => void
  const save = vi.fn().mockRejectedValueOnce(new Error("Local port is already in use."))
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    .mockResolvedValue(undefined)
  const { user } = setup({ saveNetworkPort: save })
  await user.click(screen.getByRole("button", { name: "Add port" }))
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9000")
  await user.click(screen.getByRole("button", { name: "Add" }))
  const retry = await screen.findByRole("button", { name: "Retry" })
  await user.clear(screen.getByRole("spinbutton", { name: "Port" }))
  await user.type(screen.getByRole("spinbutton", { name: "Port" }), "9001")
  await user.click(screen.getByRole("button", { name: "Add" }))
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  await user.click(retry)
  expect(save).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  await act(async () => finish())
  expect(await screen.findByText("Port 9001 added · dev")).toBeVisible()
  expect(screen.getByRole("button", { name: "Add port" })).toBeEnabled()
})


it("shows an empty filter result without waiting for unrelated network discovery", () => {
  const actions = { refreshNetwork: vi.fn(() => new Promise<void>(() => {})) } as unknown as ApplicationActions
  render(<NetworkPage workspaces={[]} browser="Firefox" actions={actions} active />)
  expect(screen.getByText("No matching sandboxes")).toBeVisible()
  expect(screen.queryByRole("status", { name: "Loading network" })).not.toBeInTheDocument()
})


it("keeps a filtered remote sandbox loading until its own network result arrives", () => {
  const local = workspaces[0]
  const remote = { ...local, device: { id: "office", vmId: local.machine.id, name: "Office", address: "office.test", connected: true } }
  const target = remoteWorkspaceTarget("office", local.machine.id)
  const actions = { refreshNetwork: vi.fn(async () => {}) } as unknown as ApplicationActions
  const localOnly = { workspaces: [{ workspace: "dev", error: null, ports: [] }] }
  const view = render(<NetworkPage workspaces={[remote]} browser="Firefox" network={localOnly} actions={actions} active />)
  expect(screen.getByRole("status", { name: "Loading network" })).toBeVisible()
  expect(screen.queryByText("No ports")).not.toBeInTheDocument()
  view.rerender(<NetworkPage workspaces={[remote]} browser="Firefox" network={{ workspaces: [...localOnly.workspaces, { workspace: target, error: null, ports: [] }] }} actions={actions} active />)
  expect(screen.queryByRole("status", { name: "Loading network" })).not.toBeInTheDocument()
  expect(screen.getByText("No ports")).toBeVisible()
})

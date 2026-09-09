import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { NetworkPage } from "./network-page"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import type { ApplicationActions, NetworkState } from "../model/application-source"
const workspaces = [applicationSourceForScenario("complete").workspaces[0]]
const network: NetworkState = {workspaces:[{workspace:"dev",error:null,ports:[
  {port:3000,hostPort:43000,scheme:"http",state:"reachable",configured:true},
  {port:5432,hostPort:45432,scheme:null,state:"reachable",configured:true},
  {port:8080,hostPort:null,scheme:null,state:"unpublished",configured:false},
]}]}
function setup(overrides: Partial<ApplicationActions> = {}, state: NetworkState | undefined = network) {
  const actions = { refreshNetwork: vi.fn(async () => {}), saveNetworkPort: vi.fn(async () => {}), removeNetworkPort: vi.fn(async () => {}), openNetworkPort: vi.fn(async () => {}), ...overrides } as unknown as ApplicationActions
  return {actions,user:userEvent.setup(),...render(<NetworkPage workspaces={workspaces} browser="Firefox" network={state} actions={actions} active />)}
}
describe("Network", () => {
  it("uses actual forwarded addresses and opens only reachable web services", async () => {
    const {user,actions} = setup()
    expect(screen.getByText("127.0.0.1:45432")).toBeVisible()
    expect(screen.queryByRole("button",{name:/Open .*45432/})).not.toBeInTheDocument()
    expect(screen.getByText("VM only")).toBeVisible()
    await user.click(screen.getByRole("button",{name:"Open http://127.0.0.1:43000 in Firefox"}))
    expect(actions.openNetworkPort).toHaveBeenCalledWith("dev",3000)
    expect(screen.queryByText(/silo.test/)).not.toBeInTheDocument()
  })
  it("adds an explicit mapping with automatic local port and preserves errors", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Local port is already in use.")).mockResolvedValueOnce(undefined)
    const {user} = setup({saveNetworkPort:save})
    await user.click(screen.getByRole("button",{name:"Add port"}))
    await user.type(screen.getByRole("spinbutton",{name:"VM port"}),"9000")
    await user.selectOptions(screen.getByRole("combobox",{name:"Protocol"}),"tcp")
    await user.click(screen.getByRole("button",{name:"Add"}))
    expect(save).toHaveBeenCalledWith({workspace:"dev",port:9000,hostPort:null,scheme:null})
    expect(screen.getByRole("alert")).toHaveTextContent("Local port is already in use.")
    expect(screen.getByRole("spinbutton",{name:"VM port"})).toHaveValue(9000)
    await user.click(screen.getByRole("button",{name:"Add"}))
    expect(screen.queryByRole("spinbutton",{name:"VM port"})).not.toBeInTheDocument()
  })
  it("requires inline removal confirmation with Cancel and Escape", async () => {
    const {user,actions} = setup()
    await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
    expect(screen.getByRole("button",{name:"Cancel"})).toBeVisible()
    expect(actions.removeNetworkPort).not.toHaveBeenCalled()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("button",{name:"Cancel"})).not.toBeInTheDocument()
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
    expect(screen.queryByText("No configured ports")).not.toBeInTheDocument()
  })
  it("does not open cached services when the VM status is stale", () => {
    const actions = {refreshNetwork:vi.fn(async () => {}),openNetworkPort:vi.fn(async () => {})} as unknown as ApplicationActions
    render(<NetworkPage workspaces={workspaces.map(w => ({...w,freshness:"stale"}))} browser="Firefox" network={network} actions={actions} active />)
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

it("connects a detected port immediately without a form", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:"Connect port 8080 to this computer"}))
  expect(actions.saveNetworkPort).toHaveBeenCalledWith({workspace:"dev",port:8080,hostPort:null,scheme:"http"})
  expect(screen.queryByRole("spinbutton",{name:"VM port"})).not.toBeInTheDocument()
})
it("edits protocol without fixing an automatic port and allows a local override", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:"Edit port 3000 from dev"}))
  expect(screen.getByRole("spinbutton",{name:"VM port"})).toBeDisabled()
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
it("uses icons for removal confirmation and dismisses on outside click", async () => {
  const {user,actions} = setup()
  await user.click(screen.getByRole("button",{name:"Remove port 3000 from dev"}))
  expect(screen.getByRole("button",{name:"Cancel"}).textContent).toBe("")
  expect(screen.getByRole("button",{name:"Remove"}).textContent).toBe("")
  await user.click(screen.getByText("127.0.0.1:45432"))
  expect(screen.queryByRole("button",{name:"Remove"})).not.toBeInTheDocument()
  expect(actions.removeNetworkPort).not.toHaveBeenCalled()
})

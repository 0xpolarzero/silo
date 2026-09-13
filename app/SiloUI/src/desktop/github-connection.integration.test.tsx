import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"
import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { createMemorySettingsStore, SettingsProvider } from "@/features/preferences/settings-store"
import { ProductionOnboarding } from "./production-onboarding"
import { createProductionSource, useProductionSource, type ProductionBridge, type ProductionSource } from "./production-source"

function Setup({ source }: { source: ProductionSource }) {
  const snapshot = useProductionSource(source)
  return <ProductionOnboarding source={source} application={snapshot.source} dependencies={{ checks: [], retry: () => {} }} />
}

it("shows a rejected cancellation and restores Connect after a successful retry while the browser attempt remains pending", async () => {
  const user = userEvent.setup()
  const initial = applicationSourceForScenario("running")
  let live = { ...initial, github: { ...initial.github, state: "disconnected" as const, account: undefined } } as typeof initial
  const events = new Map<string, () => void>()
  let finishLogin!: (value: unknown) => void
  let denyCancellation = true
  const source = createProductionSource({
    invoke: async (command: string) => {
      if (command === "read_application_state") return structuredClone(live)
      if (command === "read_github_state") return structuredClone(live.github)
      if (command === "connect_github") {
        live = { ...live, github: { ...live.github, state: "connecting" } }
        events.get("silo://application-state-changed")?.()
        return new Promise<unknown>(resolve => { finishLogin = resolve })
      }
      if (command === "cancel_github_connection") {
        if (denyCancellation) throw new Error("cancel_github_connection not allowed by ACL")
        live = { ...live, github: { ...live.github, state: "disconnected" } }
        return structuredClone(live.github)
      }
      return undefined
    },
    listen: async (event, handler) => { events.set(event, handler); return () => { events.delete(event) } },
  } as ProductionBridge)
  await source.initialize()
  const settings = createMemorySettingsStore()
  const view = render(<SettingsProvider store={settings}><Setup source={source} /></SettingsProvider>)
  try {
    await user.click(screen.getByRole("tab", { name: /GitHub/ }))
    await user.click(screen.getByRole("button", { name: "Connect GitHub" }))
    await screen.findByRole("heading", { name: "Connecting to GitHub…" })
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent("cancel_github_connection not allowed by ACL")
    expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeEnabled()
    denyCancellation = false
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }))
    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeEnabled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await act(async () => { finishLogin({ ...live.github, state: "connected", account: "late-account" }) })
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeEnabled()
    expect(screen.queryByRole("heading", { name: "Connected to GitHub" })).not.toBeInTheDocument()
  } finally {
    view.unmount()
    source.dispose()
  }
})

import { useEffect, useId, useState } from "react"

import { Switch } from "@/components/ui/switch"
import type { ComputerUseBridge } from "./computer-use-bridge"
import type { ComputerUseApproval, ComputerUseState } from "./linux-desktop-state"

/**
 * Body of the "Created {name}" notification: the sandbox's computer use approval as an
 * "Allow without asking" switch. It reads the sandbox's own mode and renders nothing for a
 * sandbox without built-in computer use or whose state cannot be read.
 */
export function CreatedSandboxApprovalSwitch({ bridge, workspace }: { bridge: ComputerUseBridge; workspace: string }) {
  const [computerUse, setComputerUse] = useState<ComputerUseState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const switchId = useId()

  useEffect(() => {
    let current = true
    bridge.readState(workspace).then(state => { if (current) setComputerUse(state.computerUse ?? null) }, () => {})
    return () => { current = false }
  }, [bridge, workspace])

  if (!computerUse || computerUse.state === "unavailable") return null
  const change = async (mode: ComputerUseApproval) => {
    const previous = computerUse
    setBusy(true)
    setError(null)
    setComputerUse({ ...computerUse, approval: mode })
    try {
      setComputerUse((await bridge.setApproval(workspace, mode)).computerUse ?? previous)
    } catch (cause) {
      setComputerUse(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return <div className="grid gap-1 text-xs">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={switchId}>Allow without asking</label>
      <Switch id={switchId} checked={computerUse.approval === "auto"} disabled={busy || computerUse.approval === "unknown"} onCheckedChange={checked => { void change(checked ? "auto" : "ask") }} />
    </div>
    {error && <span role="alert" className="text-destructive">{error}</span>}
  </div>
}

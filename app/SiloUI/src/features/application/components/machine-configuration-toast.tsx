import { createElement, useEffect, useRef, useState } from "react"

import { skipComputerUseWait, useComputerUseBridge } from "@/desktop/computer-use-bridge"
import { CreatedSandboxApprovalSwitch } from "@/desktop/created-sandbox-toast"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"

import type { ApplicationWorkspace, SandboxConfigurationOperation } from "@/features/application/model/application-source"
import { chatGptFailure, computerUsePending, describeConfiguration, waitingForChatGpt } from "@/features/application/model/machine-configuration-progress"
import { workspaceTarget } from "@/features/application/model/remote-computers"

const TOAST_ID = "machine-configuration"
/** A settings change that finishes within this time never flashes a notification. */
const SAVE_DEBOUNCE_MS = 500

/**
 * Drives one notification for sandbox configuration changes wherever the user is: a progress
 * toast with the current step while it applies, then "Created {name}" with the computer use
 * approval switch (or a failure). Renders nothing itself.
 */
export function MachineConfigurationToast({ operation, workspaces, onOpen }: {
  operation: SandboxConfigurationOperation | null
  workspaces: readonly ApplicationWorkspace[]
  onOpen?: (machineId: string) => void
}) {
  const bridge = useComputerUseBridge()
  const local = new Map(workspaces.filter(workspace => !workspace.computer).map(workspace => [workspace.machine.id, workspace.machine.name]))
  const description = operation ? describeConfiguration(operation, local) : null
  const applying = operation?.status === "applying"
  const [debounced, setDebounced] = useState(false)
  const show = applying && (description?.kind !== "saving" || debounced)
  const tracked = useRef<{ creating: string[]; startedAt: number; shown: boolean; pending: boolean } | null>(null)
  const latest = useRef({ workspaces, bridge, onOpen })
  latest.current = { workspaces, bridge, onOpen }

  useEffect(() => {
    if (!applying) { setDebounced(false); return }
    const timer = window.setTimeout(() => setDebounced(true), SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [applying, operation?.id])

  useEffect(() => {
    if (!operation || !description) return
    if (operation.status === "applying") {
      tracked.current ??= { creating: [], startedAt: Date.now(), shown: false, pending: false }
      tracked.current.creating = description.creating
      tracked.current.pending = computerUsePending(operation)
      if (!show) return
      tracked.current.shown = true
      // Creation waits for ChatGPT for Linux before it takes its turn; the user may finish without computer use.
      const waiting = description.kind === "creating" && waitingForChatGpt(operation)
      const failed = waiting && chatGptFailure(operation) !== null
      showOperationProgress(TOAST_ID, {
        title: description.title,
        step: description.step,
        progress: description.progress,
        startedAt: tracked.current.startedAt,
        sandbox: description.creating,
        action: failed && bridge ? { label: "Retry", onClick: () => { void bridge.chatGptFor().retry() } } : undefined,
        cancel: waiting ? { label: "Finish without computer use", onCancel: () => { void skipComputerUseWait(operation.id) } } : undefined,
      })
    } else if (operation.status === "failed" && tracked.current?.shown) {
      tracked.current = null
      showOperationFailure(TOAST_ID, description.kind === "creating" ? `Could not create ${description.creating[0]}` : "Sandbox changes failed", { description: operation.error.message, native: false })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, show])

  // The operation ends by disappearing: a success for what it created, or nothing when it
  // only changed or removed sandboxes.
  const wasApplying = useRef(false)
  useEffect(() => {
    const ended = wasApplying.current && !operation
    wasApplying.current = applying
    if (!ended) return
    const finished = tracked.current
    tracked.current = null
    if (!finished?.shown) return
    const { workspaces: current, bridge: computerUse, onOpen: open } = latest.current
    const created = finished.creating.flatMap(name => current.filter(workspace => !workspace.computer && workspace.machine.name === name))
    if (created.length === 0) { dismissOperationToast(TOAST_ID); return }
    const [first] = created
    const single = created.length === 1
    showOperationSuccess(TOAST_ID, single ? `Created ${first.machine.name}` : `Created ${created.length} sandboxes`, {
      persist: true,
      sandbox: created.map(workspace => workspace.machine.name),
      description: single && computerUse && first.machine.kind === "vm" && first.machine.desktop
        ? createElement("div", { className: "grid gap-1.5" },
          finished.pending ? createElement("p", { className: "text-xs text-muted-foreground" }, "Computer use will finish setting up at first start.") : null,
          createElement(CreatedSandboxApprovalSwitch, { bridge: computerUse, workspace: workspaceTarget(first) }))
        : undefined,
      action: single && open ? { label: "Open", onClick: () => open(first.machine.id) } : undefined,
    })
  }, [operation, applying])

  useEffect(() => () => { dismissOperationToast(TOAST_ID) }, [])
  return null
}

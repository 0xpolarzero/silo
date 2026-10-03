import { useEffect, useMemo, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"

import { PersonalTokenConnection } from "@/features/github/components/personal-token-connection"
import { CopyButton } from "@/components/copy-button"
import { githubFailure } from "./github-failure"

import { InlineConfirmation } from "@/components/inline-confirmation"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { dismissOperationToast, showOperationFailure, showOperationProgress, showOperationSuccess } from "@/lib/operation-toast"
import type {
  ApplicationActions,
  ApplicationGitHubConfiguration,
  ApplicationSource,
  GitHubWorkspaceOperation,
} from "@/features/application/model/application-source"
import {
  GitHubAccessEditor,
  type GitHubIdentity,
  type GitHubRepositoryAccess,
  type GitHubRepositorySelection,
} from "@/features/github/components/github-access-editor"

type WorkspaceSelections = Record<string, GitHubRepositorySelection[]>
type WorkspaceIdentities = Record<string, GitHubIdentity>
type WorkspaceOperations = Record<string, GitHubWorkspaceOperation>

interface GitHubDraft {
  access: Record<string, GitHubRepositoryAccess>
  selections: WorkspaceSelections
  identities: WorkspaceIdentities
}

function draftFromSource(
  policiesSnapshot: ApplicationSource["github"]["workspaces"],
  deviceIdentity: ApplicationSource["github"]["deviceIdentity"],
  workspaces: ApplicationSource["workspaces"],
): GitHubDraft {
  const policies = workspaces.map((workspace) => policiesSnapshot?.find((policy) => policy.workspace === workspace.machine.name) ?? ({
    workspace: workspace.machine.name,
    repositoryMode: "selected" as const,
    allRepositoriesAllowChanges: false,
    identity: {
      name: deviceIdentity?.name ?? "",
      email: deviceIdentity?.email ?? "",
      apply: Boolean(deviceIdentity?.name.trim() && deviceIdentity.email.trim()),
    },
    repositories: workspace.githubRepositories.map((repository) => ({ repository, allowPushes: false })),
  }))

  return {
    access: Object.fromEntries(policies.map((policy) => [policy.workspace, { repositoryMode: policy.repositoryMode ?? "selected", allRepositoriesAllowChanges: policy.allRepositoriesAllowChanges ?? false, ...(policy.authenticationMethod ? { authenticationMethod: policy.authenticationMethod } : {}) }])),
    selections: Object.fromEntries(policies.map((policy) => [
      policy.workspace,
      policy.repositories.map((repository) => ({ ...repository })),
    ])),
    identities: Object.fromEntries(policies.map((policy) => [policy.workspace, { ...policy.identity }])),
  }
}

function copyDraft(draft: GitHubDraft): GitHubDraft {
  return {
    access: Object.fromEntries(Object.entries(draft.access).map(([name, access]) => [name, { ...access }])),
    selections: Object.fromEntries(Object.entries(draft.selections).map(([workspace, selections]) => [
      workspace,
      selections.map((selection) => ({ ...selection })),
    ])),
    identities: Object.fromEntries(Object.entries(draft.identities).map(([workspace, identity]) => [workspace, { ...identity }])),
  }
}

/**
 * A save of the sandboxes in `changed` only, based on the settings revision this page
 * shows. Other sandboxes keep their saved choices (for example an assignment a fork just
 * copied), and access on/off is never part of a save: a save sent right after Disable
 * access must not turn access back on.
 */
function configurationFromDraft(source: ApplicationSource, draft: GitHubDraft, changed: ReadonlySet<string>): ApplicationGitHubConfiguration {
  return {
    baseRevision: source.github.policyRevision,
    deviceIdentity: source.github.deviceIdentity ?? null,
    workspaces: source.workspaces.filter((w) => !w.device && changed.has(w.machine.name)).map(({ machine }) => ({
      workspace: machine.name,
      ...(draft.access[machine.name] ?? { repositoryMode: "selected", allRepositoriesAllowChanges: false }),
      identity: draft.identities[machine.name] ?? { name: "", email: "", apply: false },
      repositories: draft.selections[machine.name] ?? [],
    })),
  }
}

function operationsFromSource(operations: readonly GitHubWorkspaceOperation[] | undefined): WorkspaceOperations {
  return Object.fromEntries((operations ?? []).map((operation) => [operation.workspace, operation]))
}

function sameIdentity(left: GitHubIdentity | undefined, right: GitHubIdentity) {
  return left?.name === right.name && left.email === right.email && left.apply === right.apply
}

/** Small persistent label in the sandbox header; the transient progress and results live in toasts. */
function WorkspaceSyncStatus({ operation }: { operation: GitHubWorkspaceOperation }) {
  if (operation.status !== "failed") return null
  const failure = githubFailure(operation.message)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:text-destructive" aria-label={`GitHub settings not applied for ${operation.workspace}. View details`}>
          <TriangleAlert className="size-3" aria-hidden="true" />Not applied
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-3 text-[11px]">
        <p className="font-medium">{failure.message}</p>
        <p className="whitespace-pre-wrap leading-5">{failure.details}</p>
        <CopyButton variant="ghost" size="xs" value={failure.details} labels={{ idle: "Copy details", copied: "Details copied", failed: "Copy failed" }} text={{ idle: "Copy details", copied: "Copied", failed: "Copy failed" }} />
      </PopoverContent>
    </Popover>
  )
}

function firstLine(text: string) {
  return text.split("\n")[0]?.trim() ?? ""
}

export function GitHubPage({
  source,
  actions,
  onBusyChange,
}: {
  source: ApplicationSource
  actions: ApplicationActions
  onBusyChange?: (busy: boolean) => void
}) {
  const sourceDraft = useMemo(
    () => draftFromSource(source.github.workspaces, source.github.deviceIdentity, source.workspaces.filter(w => !w.device)),
    [source.github.deviceIdentity, source.github.workspaces, source.workspaces],
  )
  const workspaceOwners = useMemo(
    () => new Map(source.workspaces.filter(workspace => !workspace.device).map(({ machine }) => [machine.name, machine.id])),
    [source.workspaces],
  )
  const [draft, setDraft] = useState(() => copyDraft(sourceDraft))
  const [connectionState, setConnectionState] = useState(source.github.state)
  const [accessEnabled, setAccessEnabled] = useState(source.github.accessEnabled ?? true)
  const [workspaceOperations, setWorkspaceOperations] = useState<WorkspaceOperations>(() => operationsFromSource(source.github.workspaceOperations))
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const identityIntent = useRef<WorkspaceIdentities>(copyDraft(sourceDraft).identities)
  const saveSequence = useRef(0)
  const rejectedSaves = useRef(new Set<string>())
  const pendingSaves = useRef(new Map<string, number>())
  const saveIntents = useRef(new Map<string, ApplicationGitHubConfiguration["workspaces"][number]>())
  const workspaceOwnersRef = useRef(workspaceOwners)
  const sourceDraftKey = useRef(JSON.stringify([sourceDraft, [...workspaceOwners]]))
  const sourceOperationsKey = useRef(JSON.stringify([source.github.policyRevision, source.github.workspaceOperations]))
  // Only operations the user started here notify; remember their toasts for owner changes.
  const userInitiated = useRef(new Set<string>())
  const toastWorkspaces = useRef(new Set<string>())
  const catalogAvailable = source.github.repositoryCatalogStatus?.status !== "unavailable"
  const tokenConnected = source.github.personalToken?.state === "connected"
  const applying = Object.values(workspaceOperations).some((operation) => operation.status === "applying")
  const busy = connectionState === "connecting" || applying

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    const key = JSON.stringify([sourceDraft, [...workspaceOwners]])
    if (sourceDraftKey.current === key) return
    sourceDraftKey.current = key
    const changedOwners = new Set<string>()
    for (const [name, id] of workspaceOwnersRef.current) {
      if (workspaceOwners.get(name) === id) continue
      changedOwners.add(name)
      pendingSaves.current.delete(name)
      rejectedSaves.current.delete(name)
      saveIntents.current.delete(name)
      userInitiated.current.delete(name)
      if (toastWorkspaces.current.delete(name)) dismissOperationToast(`github-apply:${name}`)
    }
    workspaceOwnersRef.current = workspaceOwners
    const submittedIdentities = identityIntent.current
    const next = copyDraft(sourceDraft)
    for (const [workspace, policy] of saveIntents.current) {
      if (!next.access[workspace]) continue
      next.access[workspace] = { repositoryMode: policy.repositoryMode ?? "selected", allRepositoriesAllowChanges: policy.allRepositoriesAllowChanges ?? false, authenticationMethod: policy.authenticationMethod }
      next.selections[workspace] = policy.repositories.map((repository) => ({ ...repository }))
      next.identities[workspace] = { ...policy.identity }
    }
    identityIntent.current = copyDraft(next).identities
    // Preserve text still being edited; blur submits it separately.
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft((current) => {
      for (const [workspace, identity] of Object.entries(current.identities)) {
        if (!changedOwners.has(workspace) && next.identities[workspace] && !sameIdentity(submittedIdentities[workspace], identity)) next.identities[workspace] = identity
      }
      return next
    })
  }, [sourceDraft, workspaceOwners])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setConnectionState(source.github.state)
  }, [source.github])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setAccessEnabled(source.github.accessEnabled ?? true)
    // oxlint-disable-next-line react/set-state-in-effect
    setConfirmingDisconnect(false)
  }, [source.github.state, source.github.accessEnabled])

  useEffect(() => {
    const key = JSON.stringify([source.github.policyRevision, source.github.workspaceOperations])
    if (sourceOperationsKey.current === key) return
    sourceOperationsKey.current = key
    // Consecutive saves can finish with identical messages before an applying snapshot reaches the UI.
    // A new revision still settles the optimistic progress for that save.
    // oxlint-disable-next-line react/set-state-in-effect
    setWorkspaceOperations(operationsFromSource(source.github.workspaceOperations))
  }, [source.github.policyRevision, source.github.workspaceOperations])

  const retryRef = useRef(retryWorkspace)
  retryRef.current = retryWorkspace
  const workspacesRef = useRef(source.workspaces)
  workspacesRef.current = source.workspaces
  const announced = useRef(new Map<string, string>(Object.entries(workspaceOperations).map(([name, operation]) => [name, `${operation.status}|${operation.message}`])))

  useEffect(() => {
    for (const [name, operation] of Object.entries(workspaceOperations)) {
      const key = `${operation.status}|${operation.message}`
      if (announced.current.get(name) === key) continue
      announced.current.set(name, key)
      if (!userInitiated.current.has(name)) continue
      toastWorkspaces.current.add(name)
      if (operation.status !== "applying") userInitiated.current.delete(name)
      const id = `github-apply:${name}`
      const machine = workspacesRef.current.find((workspace) => !workspace.device && workspace.machine.name === name)?.machine
      const noticeSandbox = machine ? { id: machine.id, name: machine.name } : undefined
      if (operation.status === "applying") showOperationProgress(id, { title: operation.message, step: name, sandbox: name })
      else if (operation.status === "succeeded") showOperationSuccess(id, "GitHub settings applied", { description: name, sandbox: name, persist: true, noticeSandbox })
      else {
        const failure = githubFailure(operation.message)
        showOperationFailure(id, failure.message, {
          description: `${name}: ${firstLine(failure.details)}`,
          sandbox: name,
          noticeSandbox,
          retry: failure.canRetry && machine ? () => {
            const current = workspacesRef.current.find(workspace => !workspace.device && workspace.machine.name === name)
            if (current?.machine.id === machine.id) retryRef.current(name)
          } : undefined,
        })
      }
    }
    for (const name of [...announced.current.keys()]) if (!workspaceOperations[name]) announced.current.delete(name)
  }, [workspaceOperations])

  function applyWorkspaceDraft(workspace: string, nextDraft: GitHubDraft, message: string) {
    setDraft(nextDraft)
    userInitiated.current.add(workspace)
    setWorkspaceOperations((current) => ({
      ...current,
      [workspace]: { workspace, status: "applying", message },
    }))
    const sequence = ++saveSequence.current
    // A save carries every edit not yet confirmed: this one, earlier pending ones and
    // rejected ones, so one failure settles them together and a retry resends them.
    for (const name of rejectedSaves.current) pendingSaves.current.set(name, sequence)
    rejectedSaves.current.clear()
    pendingSaves.current.set(workspace, sequence)
    const submittedDraft = copyDraft({ ...nextDraft, identities: identityIntent.current })
    const intent = configurationFromDraft(source, submittedDraft, new Set([workspace])).workspaces[0]
    if (intent) saveIntents.current.set(workspace, intent)
    const configuration = configurationFromDraft(source, submittedDraft, new Set(pendingSaves.current.keys()))
    configuration.workspaces = configuration.workspaces.map((policy) => saveIntents.current.get(policy.workspace) ?? policy)
    void Promise.resolve().then(() => actions.saveGitHubConfiguration?.(configuration)).then(() => {
      for (const [name, pendingSequence] of pendingSaves.current) {
        if (pendingSequence <= sequence) {
          pendingSaves.current.delete(name)
          saveIntents.current.delete(name)
        }
      }
    }).catch((cause: unknown) => {
      if (sequence !== saveSequence.current) return
      // Each save contains the complete configuration, including earlier pending edits.
      const failedWorkspaces = [...pendingSaves.current.keys()]
      pendingSaves.current.clear()
      failedWorkspaces.forEach((name) => rejectedSaves.current.add(name))
      setWorkspaceOperations((current) => {
        const next = { ...current }
        for (const name of failedWorkspaces) {
          next[name] = { workspace: name, status: "failed", message: cause instanceof Error ? cause.message : "GitHub settings could not be saved.", canRetry: true }
        }
        return next
      })
    })
  }

  function updateSelections(workspace: string, selections: GitHubRepositorySelection[]) {
    applyWorkspaceDraft(workspace, {
      ...draft,
      selections: { ...draft.selections, [workspace]: selections },
    }, "Applying repository access…")
  }

  function updateIdentity(workspace: string, identity: GitHubIdentity) {
    const previous = draft.identities[workspace]
    const nextDraft = {
      ...draft,
      identities: { ...draft.identities, [workspace]: identity },
    }
    setDraft(nextDraft)
    if (previous?.apply !== identity.apply) commitIdentity(workspace, identity, nextDraft)
  }

  function commitIdentity(workspace: string, identity: GitHubIdentity, currentDraft = draft) {
    if ((identity.apply && (!identity.name.trim() || !identity.email.trim())) || sameIdentity(identityIntent.current[workspace], identity)) return
    identityIntent.current = { ...identityIntent.current, [workspace]: { ...identity } }
    applyWorkspaceDraft(workspace, {
      ...currentDraft,
      identities: { ...currentDraft.identities, [workspace]: identity },
    }, "Applying Git identity…")
  }

  function resetIdentity(workspace: string) {
    if (!source.github.deviceIdentity) return
    const identity = { ...source.github.deviceIdentity, apply: true }
    const nextDraft = {
      ...draft,
      identities: { ...draft.identities, [workspace]: identity },
    }
    identityIntent.current = { ...identityIntent.current, [workspace]: identity }
    applyWorkspaceDraft(workspace, nextDraft, "Applying Git identity…")
  }

  function retryWorkspace(workspace: string) {
    if (rejectedSaves.current.has(workspace)) {
      applyWorkspaceDraft(workspace, draft, "Retrying GitHub access…")
      return
    }
    userInitiated.current.add(workspace)
    setWorkspaceOperations((current) => ({
      ...current,
      [workspace]: { workspace, status: "applying", message: "Retrying GitHub access…" },
    }))
    actions.retryGitHubConfiguration?.(workspace)
  }

  function toggleAccess() {
    const nextEnabled = !accessEnabled
    source.workspaces.filter((w) => !w.device).forEach(({ machine }) => userInitiated.current.add(machine.name))
    actions.setGitHubAccessEnabled?.(nextEnabled)
  }

  function disconnect() {
    setConfirmingDisconnect(false)
    actions.disconnectGitHub?.()
  }

  const catalogNotice = source.github.repositoryCatalogStatus?.status === "unavailable" ? (
    <div className="flex items-center gap-3 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs" role="alert">
      <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1">{source.github.repositoryCatalogStatus.message}</span>
      {source.github.repositoryCatalogStatus.canRetry && <Button type="button" variant="outline" size="xs" onClick={() => actions.retryGitHubRepositoryCatalog?.()}>Retry repositories</Button>}
    </div>
  ) : undefined

  const accessToggle = <Button type="button" variant="outline" size="xs" disabled={applying} onClick={toggleAccess}>{accessEnabled ? "Disable access" : "Enable access"}</Button>
  const connectedActions = (
    <InlineConfirmation active={confirmingDisconnect} onDismiss={() => setConfirmingDisconnect(false)}>
      {confirmingDisconnect ? (
        <>
          <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmingDisconnect(false)}>Cancel</Button>
          <Button type="button" variant="destructive" size="xs" onClick={disconnect}>Disconnect</Button>
        </>
      ) : (
        <>
          {accessToggle}
          <Button type="button" variant="ghost" size="xs" disabled={applying} onClick={() => setConfirmingDisconnect(true)}>Disconnect</Button>
        </>
      )}
    </InlineConfirmation>
  )

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-4 py-5 sm:px-6 sm:py-6">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">GitHub access for sandboxes on this device.</p>
        {connectionState !== "connected" && tokenConnected && accessToggle}
      </div>
      <GitHubAccessEditor
        compactConnection
        workspaces={source.workspaces.filter(w => !w.device).map(({ machine }) => ({ name: machine.name }))}
        connectionState={connectionState}
        tokenConnected={tokenConnected}
        tokenConnection={<PersonalTokenConnection status={source.github.personalToken}
          onSave={actions.saveGitHubPersonalToken} onRemove={actions.removeGitHubPersonalToken} />}
        repositoryOptions={source.github.repositoryCatalog ?? []}
        workspaceSelections={draft.selections}
        workspaceRepositoryAccess={draft.access}
        onWorkspaceRepositoryAccessChange={(workspace, access) => applyWorkspaceDraft(workspace, { ...draft, access: { ...draft.access, [workspace]: access } }, "Applying repository access…")}
        workspaceIdentities={draft.identities}
        currentDeviceGitIdentity={source.github.deviceIdentity ?? null}
        onConnect={() => {
          setConnectionState("connecting")
          actions.connectGitHub?.()
        }}
        onCancelConnection={actions.cancelGitHubConnection}
        onReopenAuthorization={actions.reopenGitHubAuthorization}
        onManageRepositories={actions.manageGitHubRepositories}
        onWorkspaceSelectionsChange={updateSelections}
        onWorkspaceIdentityChange={updateIdentity}
        onCommitWorkspaceIdentity={commitIdentity}
        onResetWorkspaceIdentity={resetIdentity}
        connectedTitle={`Connected as @${source.github.account ?? "unknown"}`}
        connectedDetail={accessEnabled
          ? "Repository credentials are scoped to each sandbox."
          : "GitHub access is off for every sandbox, including sandboxes that use a personal token."}
        connectedActions={connectedActions}
        notice={catalogNotice}
        renderWorkspaceActions={({ name }) => {
          const operation = workspaceOperations[name]
          return operation ? <WorkspaceSyncStatus operation={operation} /> : undefined
        }}
        repositoryControlsAvailable={catalogAvailable && accessEnabled}
        confirmRepositoryClear
        busy={applying}
      />
    </div>
  )
}

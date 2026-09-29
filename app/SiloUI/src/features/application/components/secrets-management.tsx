import { useEffect, useRef, useState } from "react"
import { Box, Globe, KeyRound, LoaderCircle, Pencil, RotateCw, Trash2 } from "lucide-react"

import { ListRow, ListRowIcon } from "@/components/list-row"
import { ConfirmPopover } from "@/components/confirm-popover"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import { SecretEditor } from "@/features/application/components/secret-editor"
import type { ApplicationSecret, ApplicationSource, SecretConfigurationRequest } from "@/features/application/model/application-source"
import { restoreFocus } from "@/lib/focus"

function operationFailure(error: unknown, fallback: string) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : ""
  return message === "Cannot access secrets in the system credential store. Unlock it and retry." ? message : fallback
}

interface EditorState {
  secret?: ApplicationSecret
  /** Preselected sandboxes when adding a new secret scoped to one sandbox. */
  initialWorkspaces?: string[]
}

/** Shared state and operations for viewing, adding, editing, removing, and retrying secrets.
 * Both the full Secrets page and a sandbox's Secrets section drive identical row states from it. */
export function useSecretsManager({ source, onSaveSecret, onRemoveSecret, onRetrySecret }: {
  source: ApplicationSource
  onSaveSecret: (request: SecretConfigurationRequest) => Promise<void> | void
  onRemoveSecret: (id: string) => Promise<void> | void
  onRetrySecret?: (id: string) => Promise<void> | void
}) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [busy, setBusy] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: string; message: string; action: (id: string) => Promise<void> | void } | null>(null)
  const shouldRestoreFocus = useRef(false)
  const editorTrigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!editor && !saving && shouldRestoreFocus.current) {
      shouldRestoreFocus.current = false
      restoreFocus(editorTrigger.current)
    }
  }, [editor, saving])

  function openEditor(trigger: HTMLElement | null, options: EditorState = {}) {
    editorTrigger.current = trigger
    setSaveError(undefined)
    setEditor(options)
  }

  function closeEditor() {
    shouldRestoreFocus.current = true
    setEditor(null)
  }

  async function saveSecret(request: SecretConfigurationRequest) {
    setSaving(true)
    setSaveError(undefined)
    try {
      await onSaveSecret(request)
      closeEditor()
    } catch (error) {
      setSaveError(operationFailure(error, "Couldn’t save this secret. Your changes are still here. Retry."))
    } finally {
      setSaving(false)
    }
  }

  async function runOperation(id: string, action: (id: string) => Promise<void> | void) {
    setBusy(id)
    setOperationError(null)
    try {
      await action(id)
    } catch (error) {
      setOperationError({ id, message: operationFailure(error, "Couldn’t update this secret. Retry."), action })
    } finally {
      setBusy(null)
    }
  }

  function removeSecret(id: string) {
    void runOperation(id, onRemoveSecret)
  }

  return {
    source, onRetrySecret,
    editor, saving, saveError, busy, operationError,
    openEditor, closeEditor, saveSecret, runOperation, removeSecret,
  }
}

export type SecretsManager = ReturnType<typeof useSecretsManager>

/** The add-secret editor, rendered when the manager is adding a new secret. */
export function AddSecretEditor({ manager }: { manager: SecretsManager }) {
  if (!manager.editor || manager.editor.secret) return null
  return <SecretEditor
    key="add"
    source={manager.source}
    initialWorkspaces={manager.editor.initialWorkspaces}
    onSave={manager.saveSecret}
    onCancel={manager.closeEditor}
    saving={manager.saving}
    saveError={manager.saveError}
  />
}

/** A single secret row with its live state (applying/restart-required/removing), Edit and
 * Remove controls (Remove asks in a popover), failure/Retry, and the inline editor. */
export function SecretRow({ secret, manager }: { secret: ApplicationSecret; manager: SecretsManager }) {
  const { source } = manager
  const working = manager.busy === secret.id || secret.state === "applying"
  const failure = manager.operationError?.id === secret.id ? manager.operationError.message : secret.error
  const disabled = manager.saving || manager.busy !== null

  return (
    <li>
      <ListRow
        className="hover:bg-muted/35 focus-within:bg-muted/35"
        icon={<ListRowIcon aria-hidden="true"><KeyRound className="size-3.5" /></ListRowIcon>}
        title={<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="break-all font-mono">{secret.name}</h3>
          {secret.state === "applying" && <span role="status" className="text-[10px] text-muted-foreground">{secret.removing ? "Removing…" : "Applying…"}</span>}
          {secret.state === "restart-required" && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <RotateCw className="size-3" aria-hidden="true" />Restart to apply{secret.pendingWorkspaces?.length ? `: ${secret.pendingWorkspaces.join(", ")}` : ""}
            </span>
          )}
          {secret.removing && secret.state !== "applying" && <span className="text-[10px] text-muted-foreground">Removal pending</span>}
        </div>}
        detailClassName="whitespace-normal"
        detail={<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label={`Sandboxes for ${secret.name}`}>
            {secret.workspaces.map((name) => {
              const workspace = source.workspaces.find(({ machine }) => machine.name === name)
              return workspace
                ? <WorkspaceBadge key={name} name={name} state={workspace.state} computer={workspace.computer} />
                : <StatusBadge key={name} indicator={<Box className="size-2" />}>{name}</StatusBadge>
            })}
          </div>
          <p className="flex min-w-0 items-start gap-1 text-[11px] text-muted-foreground" aria-label={`Allowed domains for ${secret.name}`}>
            <Globe className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span className="break-all">{secret.allowedDomains.join(", ") || "No allowed domains"}</span>
          </p>
        </div>}
        actions={<div className="flex shrink-0 items-center gap-0.5 text-muted-foreground" role="group" aria-label={`Manage ${secret.name}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Edit ${secret.name}`} disabled={disabled || working || secret.removing} onClick={(event) => manager.openEditor(event.currentTarget, { secret })}>
                <Pencil aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Edit ${secret.name}`}</TooltipContent>
          </Tooltip>
          <ConfirmPopover align="end" tone="destructive" title={`Remove ${secret.name}?`} description="Sandboxes using it lose access after they restart." confirmLabel="Remove" tooltip={`Remove ${secret.name}`} onConfirm={() => manager.removeSecret(secret.id)}>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${secret.name}`} disabled={disabled || working || secret.removing}>
              {working ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
            </Button>
          </ConfirmPopover>
        </div>}
      />
      {failure && <div className="flex items-center justify-between gap-3 px-3 pb-3 text-[11px] text-destructive">
        <p role="alert">{failure}</p>
        <Button variant="outline" size="xs" disabled={disabled || (!manager.onRetrySecret && manager.operationError?.id !== secret.id)} onClick={() => { const action = manager.operationError?.id === secret.id ? manager.operationError.action : manager.onRetrySecret; if (action) void manager.runOperation(secret.id, action) }}>
          {working && <LoaderCircle className="animate-spin" aria-hidden="true" />}Retry
        </Button>
      </div>}
      {manager.editor?.secret?.id === secret.id && <div className="border-t border-border"><SecretEditor key={secret.id} secret={secret} source={source} onSave={manager.saveSecret} onCancel={manager.closeEditor} saving={manager.saving} saveError={manager.saveError} /></div>}
    </li>
  )
}

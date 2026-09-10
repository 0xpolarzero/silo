import { useEffect, useRef, useState } from "react"
import { Box, Check, Globe, KeyRound, LoaderCircle, Pencil, Plus, RotateCw, Trash2, X } from "lucide-react"

import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { InlineConfirmation } from "@/components/inline-confirmation"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import { SecretEditor } from "@/features/application/components/secret-editor"
import type { ApplicationSecret, ApplicationSource, SecretConfigurationRequest } from "@/features/application/model/application-source"
import { restoreFocus } from "@/lib/focus"

function operationFailure(error: unknown, fallback: string) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : ""
  return message === "Cannot access secrets in the system credential store. Unlock it and retry." ? message : fallback
}

export function SecretsPage({ source, onSaveSecret, onRemoveSecret, onRetrySecret }: {
  source: ApplicationSource
  onSaveSecret: (request: SecretConfigurationRequest) => Promise<void> | void
  onRemoveSecret: (id: string) => Promise<void> | void
  onRetrySecret?: (id: string) => Promise<void> | void
}) {
  const secrets = source.secrets
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ secret?: ApplicationSecret } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [busy, setBusy] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: string; message: string; action: (id: string) => Promise<void> | void } | null>(null)
  const shouldRestoreFocus = useRef(false)
  const editorTrigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setPendingRemoval(null)
  }, [source.secrets])

  useEffect(() => {
    if (!editor && !saving && shouldRestoreFocus.current) {
      shouldRestoreFocus.current = false
      restoreFocus(editorTrigger.current)
    }
  }, [editor, saving])

  function openEditor(trigger: HTMLButtonElement, secret?: ApplicationSecret) {
    editorTrigger.current = trigger
    setPendingRemoval(null)
    setSaveError(undefined)
    setEditor({ secret })
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
      setPendingRemoval(null)
    } catch (error) {
      setOperationError({ id, message: operationFailure(error, "Couldn’t update this secret. Retry."), action })
    } finally {
      setBusy(null)
    }
  }

  function removeSecret(id: string) {
    if (pendingRemoval !== id) {
      setPendingRemoval(id)
      return
    }
    void runOperation(id, onRemoveSecret)
  }

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-2 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-medium">Secrets</h2>
          <p className="text-[11px] text-muted-foreground"><span>{secrets.length} configured</span> · This computer</p>
        </div>
        <Button type="button" variant="outline" size="xs" aria-label="Add secret" disabled={saving || busy !== null} onClick={(event) => openEditor(event.currentTarget)}>
          <Plus aria-hidden="true" data-icon="inline-start" /> Add
        </Button>
      </header>
      {editor && !editor.secret && <ListCard><SecretEditor key="add" source={source} onSave={saveSecret} onCancel={closeEditor} saving={saving} saveError={saveError} /></ListCard>}
      {secrets.length > 0 ? (
        <TooltipProvider delayDuration={150}>
          <ListCard>
            <ul className="divide-y divide-border" aria-label="Configured secrets">
              {secrets.map((secret) => {
                const working = busy === secret.id || secret.state === "applying"
                const failure = operationError?.id === secret.id ? operationError.message : secret.error
                const confirmingRemoval = pendingRemoval === secret.id
                const removalLabel = confirmingRemoval ? `Confirm removal of ${secret.name}` : `Remove ${secret.name}`

                return (
                  <li key={secret.id}>
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
                              ? <WorkspaceBadge key={name} name={name} state={workspace.state} />
                              : <StatusBadge key={name} indicator={<Box className="size-2" />}>{name}</StatusBadge>
                          })}
                        </div>
                        <p className="flex min-w-0 items-start gap-1 text-[11px] text-muted-foreground" aria-label={`Allowed domains for ${secret.name}`}>
                          <Globe className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                          <span className="break-all">{secret.allowedDomains.join(", ") || "No allowed domains"}</span>
                        </p>
                      </div>}
                      actions={<div className="flex shrink-0 items-center gap-0.5 text-muted-foreground" role="group" aria-label={`Manage ${secret.name}`}>
                        <InlineConfirmation active={confirmingRemoval} onDismiss={() => setPendingRemoval(null)}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" variant="ghost" size="icon-xs" aria-label={confirmingRemoval ? `Cancel removal of ${secret.name}` : `Edit ${secret.name}`} disabled={saving || busy !== null || working || secret.removing} onClick={(event) => confirmingRemoval ? setPendingRemoval(null) : openEditor(event.currentTarget, secret)}>
                                {confirmingRemoval ? <X aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{confirmingRemoval ? "Cancel" : `Edit ${secret.name}`}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button type="button" variant={confirmingRemoval ? "destructive" : "ghost"} size="icon-xs" aria-label={removalLabel} disabled={saving || busy !== null || working || secret.removing} onClick={() => removeSecret(secret.id)}>
                                {working ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : confirmingRemoval ? <Check aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{removalLabel}</TooltipContent>
                          </Tooltip>
                        </InlineConfirmation>
                      </div>}
                    />
                    {failure && <div className="flex items-center justify-between gap-3 px-3 pb-3 text-[11px] text-destructive">
                      <p role="alert">{failure}</p>
                      <Button variant="outline" size="xs" disabled={saving || busy !== null || (!onRetrySecret && operationError?.id !== secret.id)} onClick={() => { const action = operationError?.id === secret.id ? operationError.action : onRetrySecret; if (action) void runOperation(secret.id, action) }}>
                        {working && <LoaderCircle className="animate-spin" aria-hidden="true" />}Retry
                      </Button>
                    </div>}
                    {editor?.secret?.id === secret.id && <div className="border-t border-border"><SecretEditor key={secret.id} secret={secret} source={source} onSave={saveSecret} onCancel={closeEditor} saving={saving} saveError={saveError} /></div>}
                  </li>
                )
              })}
            </ul>
          </ListCard>
        </TooltipProvider>
      ) : <p className="rounded-md border border-border px-3 py-6 text-center text-xs text-muted-foreground">No secrets configured.</p>}
    </div>
  )
}

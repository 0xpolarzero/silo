import { parseRemoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Monitor, Server } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import type { SetupMachineConfiguration, SetupVirtualMachineConfiguration } from "@/contracts/silo"
import {
  maximumMachineCount,
  supportedCPUs,
  supportedMemoryGiB,
  supportedStorageGiB,
  validateMachine,
  type MachineValidationErrors,
} from "@/features/onboarding/model/machine-configuration"
import { divergentMachineFields, sameMachineConfiguration } from "@/features/application/model/machine-change"
import type { MachineEditorDraft } from "@/features/onboarding/model/onboarding-draft"
import { parseWholeNumber, presetsWithin, resourceFields, resourceMaximums, runtimeLimits, validateMachineResources, type HostCapacity } from "@/features/sandboxes/model/machine-limits"

function SelectField({ label, value, values, suffix, max, error, readOnly = false, custom = false, onChange }: {
  label: string
  value: number
  values: readonly number[]
  suffix: string
  /** The largest custom value the runtime accepts for this field. */
  max: number
  readOnly?: boolean
  custom?: boolean
  error?: string
  onChange: (value: number) => void
}) {
  const [customSelected, setCustomSelected] = useState(!values.includes(value))
  const isCustom = custom && (customSelected || !values.includes(value))
  // The custom input keeps the user's text ("1.5", "1e3", "") so it can be corrected;
  // the draft only receives whole numbers, and anything else fails validation.
  const [customText, setCustomText] = useState(value ? String(value) : "")
  const errorId = useId()
  const describedBy = error ? errorId : undefined
  const field = (
    <div className="grid min-w-0 gap-1 text-[11px] font-medium text-muted-foreground">
      {label}
      <select
        disabled={readOnly}
        aria-label={label}
        // With a custom value, the number input holds it and takes focus on failed validation.
        aria-invalid={Boolean(error) && !isCustom}
        aria-describedby={describedBy}
        className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-xs text-foreground disabled:cursor-default disabled:opacity-60 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
        value={isCustom ? "custom" : value}
        onChange={(event) => {
          const selected = event.target.value
          setCustomSelected(selected === "custom")
          if (selected === "custom") setCustomText(value ? String(value) : "")
          else onChange(Number(selected))
        }}
      >
        {values.map((option) => <option key={option} value={option}>{option} {suffix}</option>)}
        {custom && <option value="custom">Custom…</option>}
      </select>
      {isCustom && <Input technical
        type="number" inputMode="numeric" disabled={readOnly} min={1} max={max} step={1}
        aria-label={`${label} custom (${suffix === "CPU" ? "CPUs" : "GiB"})`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        value={customText}
        onChange={(event) => {
          setCustomText(event.target.value)
          onChange(parseWholeNumber(event.target.value))
        }}
      />}
      {error && <span id={errorId} className="text-destructive">{error}</span>}
    </div>
  )
  return readOnly ? (
    <TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={`${label}: ${value} ${suffix}, read-only`}>{field}</span></TooltipTrigger>
      <TooltipContent>To use a different disk size, create a new VM and transfer your data.</TooltipContent>
    </Tooltip></TooltipProvider>
  ) : field
}

function TextField({ label, value, error, firstField = false, inputRef, ...props }: {
  label: string
  value: string
  error?: string
  firstField?: boolean
  inputRef?: React.RefObject<HTMLInputElement | null>
} & Omit<React.ComponentProps<typeof Input>, "value" | "aria-label">) {
  const errorId = useId()
  return (
    <label className="grid min-w-0 gap-1 text-[11px] font-medium text-muted-foreground">
      {label}
      <Input technical ref={firstField ? inputRef : undefined} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={value} {...props} />
      {error && <span id={errorId} className="text-destructive">{error}</span>}
    </label>
  )
}

export function MachineEditor({ saving, editorHeader, editor, focusRequest, machines, baselineMachine, conflict = false, onCancel, onSave, onDraftChange, onReview, onDiscard, created, running, capacity, computerName }: {
  saving?: boolean
  editorHeader?: ReactNode
  editor: MachineEditorDraft
  focusRequest: number
  created: boolean
  running: boolean
  /** The CPUs and memory of the computer the sandbox runs on, when known. */
  capacity?: HostCapacity
  /** That computer's name for messages; defaults to "This computer". */
  computerName?: string
  machines: readonly SetupMachineConfiguration[]
  /** The VM's saved configuration when this editor opened, for divergence detection. */
  baselineMachine?: SetupMachineConfiguration
  /** A save was rejected because the VM changed while the edit waited. */
  conflict?: boolean
  onCancel: () => void
  onSave: (machine: SetupMachineConfiguration) => void
  onDraftChange: (draft: SetupMachineConfiguration) => void
  onReview?: () => void
  onDiscard?: () => void
}) {
  const [draft, setDraft] = useState(editor.draft)
  const [errors, setErrors] = useState<MachineValidationErrors>({})
  const firstField = useRef<HTMLInputElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const portErrorId = useId()
  // Bumped by each failed Save so focus moves to the first invalid field once it renders.
  const [failedValidation, setFailedValidation] = useState(0)
  const original = machines.find(machine => machine.id === editor.originalID)
  // Detect that the committed VM changed under the open editor. `baselineMachine` is only
  // supplied for edits backed by a live source (not onboarding drafts), so these notices
  // stay quiet there. A missing live machine for an edit means it was deleted elsewhere.
  const deletedElsewhere = Boolean(editor.originalID) && baselineMachine !== undefined && !original
  const divergent = Boolean(baselineMachine && original && !sameMachineConfiguration(baselineMachine, original))
  const changedFields = divergent && baselineMachine && original ? divergentMachineFields(baselineMachine, original) : []
  const desktopInstalled = created && original?.kind === "vm" && Boolean(original.desktop)
  const desktopOnlyChange = original?.kind === "vm" && draft.kind === "vm"
    && JSON.stringify(original.desktop) !== JSON.stringify(draft.desktop)
    && JSON.stringify({ ...original, desktop: undefined }) === JSON.stringify({ ...draft, desktop: undefined })
  const requiresStop = running && !desktopOnlyChange
  // Offer only what the computer can run; the runtime rejects ceilings above it.
  const maximums = resourceMaximums(capacity)
  const cpuPresets = presetsWithin(supportedCPUs, capacity?.logicalCPUs)
  const memoryPresets = presetsWithin(supportedMemoryGiB, capacity?.memoryGiB)

  useEffect(() => {
    firstField.current?.focus()
    firstField.current?.scrollIntoView?.({ block: "nearest" })
  }, [focusRequest])

  useEffect(() => {
    if (!failedValidation) return
    container.current?.querySelector<HTMLElement>("[aria-invalid='true']:not(:disabled)")?.focus()
  }, [failedValidation])

  function update(changes: Partial<SetupMachineConfiguration>) {
    const next = { ...draft, ...changes } as SetupMachineConfiguration
    setDraft(next)
    onDraftChange(next)
    setErrors({})
  }

  function save() {
    const nativeId = (id: string) => parseRemoteWorkspaceTarget(id)?.vmId ?? id
    const nextErrors = validateMachine({ ...draft, id: nativeId(draft.id) }, machines.map(machine => ({ ...machine, id: nativeId(machine.id) })), editor.originalID ? nativeId(editor.originalID) : undefined)
    if (draft.kind === "vm") {
      // Resource fields get readable range messages instead of the contract schema's.
      for (const field of resourceFields) delete nextErrors[field]
      Object.assign(nextErrors, validateMachineResources(draft, capacity, computerName))
    }
    if (!editor.originalID && machines.length >= maximumMachineCount) {
      nextErrors.form = `Configure no more than ${maximumMachineCount} sandboxes.`
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length === 0) onSave(draft)
    else setFailedValidation(count => count + 1)
  }

  return (
    <div ref={container} className="grid min-w-0 gap-3 p-3" data-testid={`machine-editor-${draft.id}`}>
      <div className="flex min-w-0 items-center gap-2">
        {draft.kind === "vm" ? <Monitor className="size-4 shrink-0" aria-hidden="true" /> : <Server className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1 text-xs font-semibold">{draft.kind === "vm" ? "Virtual machine details" : "SSH machine details"}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">{draft.kind}</span>
      </div>

      {editorHeader}
      {deletedElsewhere ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/[.06] px-3 py-2 text-xs text-destructive">This VM no longer exists.</p>
      ) : conflict ? (
        <div role="alert" className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/[.06] px-3 py-2 text-xs text-destructive">
          <p>This VM changed since you opened it.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="outline" disabled={saving} onClick={onDiscard}>Discard my edits</Button>
            <Button type="button" size="xs" disabled={saving} onClick={onReview}>Review changes</Button>
          </div>
        </div>
      ) : divergent ? (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This VM was changed elsewhere.{changedFields.length > 0 ? ` Updated: ${changedFields.join(", ")}.` : ""}
        </p>
      ) : null}
      {/* Lock every field while saving so edits typed after Save aren't silently discarded. */}
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <TextField
        firstField
        inputRef={firstField}
        label="Machine name"
        value={draft.name}
        readOnly={created}
        className={created ? "opacity-60" : undefined}
        error={errors.name}
        autoComplete="off"
        maxLength={32}
        onChange={(event) => update({ name: event.target.value })}
      />

      {created && draft.kind === "vm" && <p className="text-[11px] text-muted-foreground">Existing VMs cannot be renamed or have their disks resized.</p>}

      {draft.kind === "vm" ? (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <SelectField custom label="CPU limit" value={draft.cpus} values={cpuPresets} max={maximums.cpus} suffix="CPU" error={errors.cpus} onChange={(cpus) => update({ cpus } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="CPU ceiling" value={draft.maxCPUs} values={cpuPresets} max={maximums.cpus} suffix="CPU" error={errors.maxCPUs} onChange={(maxCPUs) => update({ maxCPUs } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="Memory limit" value={draft.memoryGiB} values={memoryPresets} max={maximums.memoryGiB} suffix="GB" error={errors.memoryGiB} onChange={(memoryGiB) => update({ memoryGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="Memory ceiling" value={draft.maxMemoryGiB} values={memoryPresets} max={maximums.memoryGiB} suffix="GB" error={errors.maxMemoryGiB} onChange={(maxMemoryGiB) => update({ maxMemoryGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom readOnly={created} label="Workspace storage" value={draft.workspaceStorageGiB} values={supportedStorageGiB} max={runtimeLimits.storageGiB} suffix="GB" error={errors.workspaceStorageGiB} onChange={(workspaceStorageGiB) => update({ workspaceStorageGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom readOnly={created} label="Runtime storage" value={draft.runtimeStorageGiB} values={supportedStorageGiB} max={runtimeLimits.storageGiB} suffix="GB" error={errors.runtimeStorageGiB} onChange={(runtimeStorageGiB) => update({ runtimeStorageGiB } as Partial<SetupVirtualMachineConfiguration>)} />
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem]">
          <TextField label="SSH host" value={draft.host} error={errors.host} autoComplete="off" placeholder="server.example.com" onChange={(event) => update({ host: event.target.value })} />
          <TextField label="SSH user" value={draft.user} error={errors.user} autoComplete="username" placeholder="developer" onChange={(event) => update({ user: event.target.value })} />
          <label className="grid min-w-0 gap-1 text-[11px] font-medium text-muted-foreground">
            SSH port
            <Input technical
              aria-label="SSH port"
              aria-invalid={Boolean(errors.port)}
              aria-describedby={errors.port ? portErrorId : undefined}
              type="number"
              inputMode="numeric"
              min={1}
              max={65_535}
              value={draft.port}
              onChange={(event) => update({ port: Number(event.target.value) })}
            />
            {errors.port && <span id={portErrorId} className="text-destructive">{errors.port}</span>}
          </label>
        </div>
      )}

      {draft.kind === "vm" && <section aria-label="Linux desktop" className="grid gap-2 border-t border-border pt-3">
        {desktopInstalled ? <label className="flex items-center justify-between gap-3 text-xs">
          <span>Start desktop with sandbox<span className="mt-1 block text-[11px] text-muted-foreground">When off, start the desktop from its viewer.</span></span>
          <Switch aria-label="Start desktop with sandbox" checked={draft.desktop?.startWithSandbox ?? true} disabled={saving} onCheckedChange={startWithSandbox => update({ desktop: { startWithSandbox } })} />
        </label> : created ? <div className="flex items-center justify-between gap-3">
          <div className="text-xs">Linux desktop<p className="mt-1 text-[11px] text-muted-foreground">Use graphical applications in this sandbox.</p></div>
          {draft.desktop ? <span className="text-xs text-muted-foreground">Installs when you save</span> : <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => update({ desktop: { startWithSandbox: true } })}>Add desktop</Button>}
        </div> : <label className="flex items-start gap-2 text-xs">
          <Checkbox aria-label="Linux desktop" checked={Boolean(draft.desktop)} disabled={saving} onCheckedChange={checked => update({ desktop: checked === true ? { startWithSandbox: true } : undefined })} />
          <span>Linux desktop<span className="mt-1 block text-[11px] text-muted-foreground">Run graphical applications. Starts with the sandbox.</span></span>
        </label>}
      </section>}
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" disabled={saving || deletedElsewhere} onClick={save}>{saving ? "Saving…" : requiresStop ? "Stop VM and save" : "Save"}</Button>
      </div>
      {errors.form && <p className="text-xs text-destructive" role="alert">{errors.form}</p>}
    </div>
  )
}

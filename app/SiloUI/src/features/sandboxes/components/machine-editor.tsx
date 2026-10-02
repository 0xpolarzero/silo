import { parseRemoteWorkspaceTarget } from "@/features/application/model/remote-computers"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Monitor, Server, Square } from "lucide-react"

import { InlineConfirmation } from "@/components/inline-confirmation"
import { restoreFocus } from "@/lib/focus"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import type { SetupMachineConfiguration, SetupVirtualMachineConfiguration } from "@/contracts/silo"
import {
  machineCapacityError,
  supportedCPUs,
  supportedMemoryGiB,
  supportedStorageGiB,
  validateMachine,
  type MachineValidationErrors,
} from "@/features/onboarding/model/machine-configuration"
import { divergentMachineFields, sameMachineConfiguration } from "@/features/application/model/machine-change"
import { useChatGptApp, useComputerUseBridge } from "@/desktop/computer-use-bridge"
import type { MachineEditorDraft } from "@/features/onboarding/model/onboarding-draft"
import { machineFieldLabel, type MachineReview } from "@/features/sandboxes/model/machine-review"
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
          else { setCustomText(selected); onChange(Number(selected)) }
        }}
      >
        {values.map((option) => <option key={option} value={option}>{option} {suffix}</option>)}
        {custom && <option value="custom">Custom…</option>}
      </select>
      {isCustom && <Input technical
        type="number" inputMode="numeric" disabled={readOnly} min={1} max={max} step={1}
        aria-label={`${label} custom (${suffix === "CPUs" ? "CPUs" : "GiB"})`}
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
    <TooltipProvider><Tooltip><TooltipTrigger asChild><div role="group" tabIndex={0} aria-label={`${label}: ${value} ${suffix}, read-only`} className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{field}</div></TooltipTrigger>
      <TooltipContent>Disk size is read-only.</TooltipContent>
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

export function MachineEditor({ saving, blockedReason, editorHeader, editor, focusRequest, machines, baselineMachine, conflict = false, review, onCancel, onSave, onDraftChange, onReview, onDiscard, created, running, capacity, computerName, computerId }: {
  saving?: boolean
  /** Why Save is unavailable right now (another change locks editing); the draft is kept. */
  blockedReason?: string
  editorHeader?: ReactNode
  editor: MachineEditorDraft
  focusRequest: number
  created: boolean
  running: boolean
  /** The CPUs and memory of the computer the sandbox runs on, when known. */
  capacity?: HostCapacity
  /** That computer's name for messages; defaults to "This computer". */
  computerName?: string
  /** The host id of the other computer a new sandbox will run on; empty or omitted is this one. */
  computerId?: string
  /** The computer the sandbox will run on; empty or omitted is this one. */
  machines: readonly SetupMachineConfiguration[]
  /** The VM's saved configuration when this editor opened, for divergence detection. */
  baselineMachine?: SetupMachineConfiguration
  /** A save was rejected because the VM changed while the edit waited. */
  conflict?: boolean
  /** After "Review changes": the draft was rebased onto the latest settings, with these differences. */
  review?: MachineReview | null
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
  const blockedReasonId = useId()
  // Bumped by each failed Save so focus moves to the first invalid field once it renders.
  const [failedValidation, setFailedValidation] = useState(0)
  const original = machines.find(machine => machine.id === editor.originalID)
  // Detect that the committed VM changed under the open editor. `baselineMachine` is only
  // supplied for edits backed by a live source (not onboarding drafts), so these notices
  // stay quiet there. A missing live machine for an edit means it was deleted elsewhere.
  const deletedElsewhere = Boolean(editor.originalID) && baselineMachine !== undefined && !original
  const divergent = Boolean(baselineMachine && original && !sameMachineConfiguration(baselineMachine, original))
  const changedFields = divergent && baselineMachine && original ? divergentMachineFields(baselineMachine, original) : []
  // A VM whose desktop is built into its image always starts it; only older VMs are configured here.
  const builtInDesktop = created && original?.kind === "vm" && original.desktop?.builtIn === true
  const computerUse = useComputerUseBridge()
  // A new sandbox gets the built-in desktop only if the computer it runs on can provide it.
  // This computer follows the build; another computer is asked, because it may run an
  // older Silo (and guest image) without computer use.
  const remoteOwner = !created && draft.kind === "vm" && computerId ? computerId : undefined
  const ownerApp = useChatGptApp(remoteOwner && computerUse ? computerUse.chatGptFor(remoteOwner) : undefined)
  const ownerName = computerName ?? "that computer"
  const newVmSupport: "yes" | "no" | "checking" = !computerUse ? "no"
    : !remoteOwner ? "yes"
    : ownerApp.status ? (ownerApp.status.state === "unknown" ? "no" : "yes")
    : ownerApp.loadError ? "no" : "checking"
  const builtInNewVm = !created && draft.kind === "vm" && newVmSupport === "yes"
  const startsWithSandbox = draft.kind === "vm" && draft.desktop?.startWithSandbox === false
  // Computer use needs the session running: a new built-in sandbox always starts it, so a
  // duplicate or saved draft that chose to start it by hand is corrected.
  useEffect(() => {
    if (builtInNewVm && startsWithSandbox) {
      const next = { ...draft, desktop: { startWithSandbox: true } } as SetupMachineConfiguration
      setDraft(next)
      onDraftChange(next)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtInNewVm, startsWithSandbox])
  const desktopInstalled = created && original?.kind === "vm" && Boolean(original.desktop)
  const desktopOnlyChange = original?.kind === "vm" && draft.kind === "vm"
    && JSON.stringify(original.desktop) !== JSON.stringify(draft.desktop)
    && JSON.stringify({ ...original, desktop: undefined }) === JSON.stringify({ ...draft, desktop: undefined })
  const requiresStop = running && !desktopOnlyChange
  const [confirmingStop, setConfirmingStop] = useState(false)
  // The confirmation disappears by itself if the sandbox stops elsewhere, a save starts, or
  // Save becomes blocked while it is shown.
  const stopPending = confirmingStop && requiresStop && !saving && !blockedReason && !deletedElsewhere
  const stopTarget = `${draft.name}${computerName ? ` on ${computerName}` : ""}`
  const cancelStop = useRef<HTMLButtonElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const returnFocusToSave = useRef(false)
  useEffect(() => {
    if (stopPending) cancelStop.current?.focus()
    else if (returnFocusToSave.current) { returnFocusToSave.current = false; restoreFocus(saveButton.current) }
  }, [stopPending])
  function dismissStop() {
    returnFocusToSave.current = true
    setConfirmingStop(false)
  }
  // Offer only what the computer can run; the runtime rejects ceilings above it.
  const maximums = resourceMaximums(capacity)
  const cpuPresets = presetsWithin(supportedCPUs, capacity ? maximums.cpus : undefined)
  const memoryPresets = presetsWithin(supportedMemoryGiB, capacity ? maximums.memoryGiB : undefined)

  useEffect(() => {
    // Let the opening menu finish its focus restoration before entering the editor.
    const frame = requestAnimationFrame(() => {
      firstField.current?.focus()
      firstField.current?.scrollIntoView?.({ block: "nearest" })
    })
    return () => cancelAnimationFrame(frame)
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
    setConfirmingStop(false)
  }

  function save() {
    const nativeId = (id: string) => parseRemoteWorkspaceTarget(id)?.vmId ?? id
    const nextErrors = validateMachine({ ...draft, id: nativeId(draft.id) }, machines.map(machine => ({ ...machine, id: nativeId(machine.id) })), editor.originalID ? nativeId(editor.originalID) : undefined)
    if (draft.kind === "vm") {
      // Resource fields get readable range messages instead of the contract schema's.
      for (const field of resourceFields) delete nextErrors[field]
      Object.assign(nextErrors, validateMachineResources(draft, capacity, computerName))
    }
    const capacityError = machineCapacityError(machines.length, editor.originalID)
    if (capacityError) nextErrors.form = capacityError
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) setFailedValidation(count => count + 1)
    // Stopping a running sandbox is always confirmed first (decision 8).
    else if (requiresStop) setConfirmingStop(true)
    else onSave(builtInNewVm && startsWithSandbox && draft.kind === "vm" ? { ...draft, desktop: { startWithSandbox: true } } : draft)
  }

  return (
    <div ref={container} className="grid min-w-0 gap-3 p-3" data-testid={`machine-editor-${draft.id}`}>
      <div className="flex min-w-0 items-center gap-2">
        {draft.kind === "vm" ? <Monitor className="size-4 shrink-0" aria-hidden="true" /> : <Server className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1 text-xs font-semibold">{draft.kind === "vm" ? "Sandbox details" : "SSH host details"}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">{draft.kind === "ssh" ? "SSH host" : draft.kind}</span>
      </div>

      {editorHeader}
      {deletedElsewhere ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/[.06] px-3 py-2 text-xs text-destructive">This sandbox no longer exists.</p>
      ) : conflict ? (
        <div role="alert" className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/[.06] px-3 py-2 text-xs text-destructive">
          <p>This sandbox changed since you opened it.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="outline" disabled={saving} onClick={onDiscard}>Discard my edits</Button>
            <Button type="button" size="xs" disabled={saving} onClick={onReview}>Review changes</Button>
          </div>
        </div>
      ) : divergent ? (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This sandbox was changed elsewhere.{changedFields.length > 0 ? ` Updated: ${changedFields.map(machineFieldLabel).join(", ")}.` : ""}
        </p>
      ) : review ? (
        <div role="status" aria-label="Review changes" className="grid gap-1 rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <p>Your edits are kept on top of the latest settings.</p>
          {review.conflicts.length > 0 && <>
            <p>Also changed elsewhere:</p>
            <ul className="grid gap-0.5 pl-3">
              {review.conflicts.map(conflict => <li key={conflict.field} className="list-disc">{conflict.label}: yours {conflict.mine}, elsewhere {conflict.theirs}</li>)}
            </ul>
          </>}
          {review.adopted.length > 0 && <p>Updated from elsewhere: {review.adopted.join(", ")}.</p>}
          <p>Save to apply your edits, or Cancel to keep the latest settings.</p>
        </div>
      ) : null}
      {/* Lock every field while saving so edits typed after Save aren't silently discarded. */}
      <fieldset disabled={saving} className="m-0 grid min-w-0 gap-3 border-0 p-0">
      <TextField
        firstField
        inputRef={firstField}
        label={draft.kind === "vm" ? "Sandbox name" : "SSH host name"}
        value={draft.name}
        readOnly={created}
        className={created ? "opacity-60" : undefined}
        error={errors.name}
        autoComplete="off"
        maxLength={32}
        onChange={(event) => update({ name: event.target.value })}
      />

      {created && draft.kind === "vm" && <p className="text-[11px] text-muted-foreground">Existing sandboxes cannot be renamed or have their disks resized. To use a different disk size, create a new sandbox and transfer your data.</p>}
      {editor.displayAfterID && <p className="text-[11px] text-muted-foreground">{draft.kind === "vm" ? "Creates a new empty sandbox with the same settings. Files are not included." : "Creates a new SSH host connection with the same settings."}</p>}

      {draft.kind === "vm" ? (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <p className="col-span-full text-[11px] text-muted-foreground">CPUs and Memory set the startup allocation; ceilings set the maximum. The Workspace disk holds /workspace; the Runtime disk holds the operating system and installed applications.</p>
          <SelectField custom label="CPUs" value={draft.cpus} values={cpuPresets} max={maximums.cpus} suffix="CPUs" error={errors.cpus} onChange={(cpus) => update({ cpus } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="CPUs ceiling" value={draft.maxCPUs} values={cpuPresets} max={maximums.cpus} suffix="CPUs" error={errors.maxCPUs} onChange={(maxCPUs) => update({ maxCPUs } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="Memory" value={draft.memoryGiB} values={memoryPresets} max={maximums.memoryGiB} suffix="GiB" error={errors.memoryGiB} onChange={(memoryGiB) => update({ memoryGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom label="Memory ceiling" value={draft.maxMemoryGiB} values={memoryPresets} max={maximums.memoryGiB} suffix="GiB" error={errors.maxMemoryGiB} onChange={(maxMemoryGiB) => update({ maxMemoryGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom readOnly={created} label="Workspace disk" value={draft.workspaceStorageGiB} values={supportedStorageGiB} max={runtimeLimits.storageGiB} suffix="GiB" error={errors.workspaceStorageGiB} onChange={(workspaceStorageGiB) => update({ workspaceStorageGiB } as Partial<SetupVirtualMachineConfiguration>)} />
          <SelectField custom readOnly={created} label="Runtime disk" value={draft.runtimeStorageGiB} values={supportedStorageGiB} max={runtimeLimits.storageGiB} suffix="GiB" error={errors.runtimeStorageGiB} onChange={(runtimeStorageGiB) => update({ runtimeStorageGiB } as Partial<SetupVirtualMachineConfiguration>)} />
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

      {draft.kind === "vm" && (builtInDesktop || builtInNewVm) && <section aria-label="Linux desktop" className="grid gap-2 border-t border-border pt-3">
        <div className="text-xs">Linux desktop and computer use<p className="mt-1 text-[11px] text-muted-foreground">{builtInDesktop ? "Built in. The desktop starts with the sandbox." : "Built in. Agents in this sandbox can use graphical applications."}</p></div>
      </section>}
      {draft.kind === "vm" && !builtInDesktop && !builtInNewVm && <section aria-label="Linux desktop" className="grid gap-2 border-t border-border pt-3">
        {!created && computerUse && remoteOwner && (newVmSupport === "no"
          ? <p className="text-[11px] text-muted-foreground">Update Silo on {ownerName} for built-in computer use. Until then, this sandbox can have the optional Linux desktop.</p>
          : newVmSupport === "checking" ? <p role="status" className="text-[11px] text-muted-foreground">Checking whether {ownerName} supports built-in computer use…</p> : null)}
        {desktopInstalled ? <label className="flex items-center justify-between gap-3 text-xs">
          <span>Start desktop with sandbox<span className="mt-1 block text-[11px] text-muted-foreground">When off, start the desktop from its viewer.</span></span>
          <Switch aria-label="Start desktop with sandbox" checked={draft.desktop?.startWithSandbox ?? true} disabled={saving} onCheckedChange={startWithSandbox => update({ desktop: { startWithSandbox } })} />
        </label> : created ? <div className="flex items-center justify-between gap-3">
          <div className="text-xs">Linux desktop<p className="mt-1 text-[11px] text-muted-foreground">Use graphical applications in this sandbox.</p></div>
          {draft.desktop ? <span className="text-xs text-muted-foreground">Installs when you save</span> : <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => update({ desktop: { startWithSandbox: true } })}>Add Linux desktop</Button>}
        </div> : <label className="flex items-start gap-2 text-xs">
          <Checkbox aria-label="Linux desktop" checked={Boolean(draft.desktop)} disabled={saving} onCheckedChange={checked => update({ desktop: checked === true ? { startWithSandbox: true } : undefined })} />
          <span>Linux desktop<span className="mt-1 block text-[11px] text-muted-foreground">Run graphical applications. Starts with the sandbox.</span></span>
        </label>}
      </section>}
      </fieldset>

      <p role={saving ? "status" : undefined} aria-live="polite" aria-atomic="true" className="sr-only">{saving ? `Saving ${draft.name}…` : ""}</p>
      {blockedReason && !saving && <p id={blockedReasonId} role="status" className="text-right text-[11px] text-muted-foreground">{blockedReason}</p>}
      {stopPending ? <InlineConfirmation active onDismiss={dismissStop}>
        <div role="group" aria-label={`Stop ${stopTarget} and save?`} className="grid gap-2 rounded-md border border-border px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Stop {stopTarget} and save? Running processes will be interrupted. The new settings apply when you start it again.</p>
          <div className="flex justify-end gap-1.5">
            <Button ref={cancelStop} type="button" variant="ghost" size="xs" onClick={dismissStop}>Cancel</Button>
            <Button type="button" variant="destructive" size="xs" onClick={() => { setConfirmingStop(false); onSave(draft) }}><Square />Stop and save</Button>
          </div>
        </div>
      </InlineConfirmation> : <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button ref={saveButton} type="button" size="sm" disabled={saving || deletedElsewhere || Boolean(blockedReason)} aria-describedby={blockedReason && !saving ? blockedReasonId : undefined} onClick={save}>{saving ? "Saving…" : requiresStop ? "Stop and save…" : "Save"}</Button>
      </div>}
      {errors.form && <p className="text-xs text-destructive" role="alert">{errors.form}</p>}
    </div>
  )
}

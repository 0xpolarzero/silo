import { CircleAlert, Loader2, TriangleAlert } from "lucide-react"
import { useEffect, useEffectEvent, useState } from "react"

import { CopyButton } from "@/components/copy-button"
import { ErrorDetails } from "@/components/error-details"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DisabledReason } from "@/features/application/components/disabled-reason"
import type { AccountMigrationPlan, ApplicationWorkspace } from "@/features/application/model/application-source"
import { formatSandboxSize } from "@/features/sandboxes/model/delete-sandbox-copy"
import { migrationErrorMessage } from "@/features/application/model/account-migration"

/** Marks popover content that needs the wide popover: steps and a full backup path. */
const WIDE_POPOVER = { "data-popover-wide": "" }

type PlanState =
  | { status: "loading" }
  | { status: "ready"; plan: AccountMigrationPlan }
  | { status: "failed"; message: string }

function BackupPath({ path }: { path: string }) {
  return <span className="flex min-w-0 items-start gap-1">
    <span className="min-w-0 break-all font-mono text-[11px] text-foreground">{path}</span>
    <CopyButton value={path} variant="ghost" size="icon-xs" className="-my-0.5 shrink-0" labels={{ idle: "Copy backup location", copied: "Backup location copied", failed: "Copy backup location failed" }} />
  </span>
}

/**
 * The migration confirmation, from the ⋯ menu or the sandbox page: the dry-run plan, the
 * backup's size and location, the free space it needs, and a warning that files inside the
 * sandbox are rewritten. Migrate stays unavailable until the backup fits.
 */
export function AccountMigrationBody({ sandboxName, computerName, plan, onMigrate, onClose }: {
  sandboxName: string
  /** The computer that owns a remote sandbox, where the backup is written. */
  computerName?: string
  plan: () => Promise<AccountMigrationPlan>
  onMigrate: () => void | Promise<unknown>
  onClose: () => void
}) {
  const [state, setState] = useState<PlanState>({ status: "loading" })
  const [check, setCheck] = useState(0)
  const read = useEffectEvent(() => plan())
  useEffect(() => {
    let current = true
    read()
      .then((value) => { if (current) setState({ status: "ready", plan: value }) })
      .catch((cause: unknown) => { if (current) setState({ status: "failed", message: migrationErrorMessage(cause) }) })
    return () => { current = false }
  }, [check])
  function checkAgain() {
    setState({ status: "loading" })
    setCheck((value) => value + 1)
  }
  function migrate() {
    onClose()
    void Promise.resolve().then(onMigrate)
  }

  const cancel = <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
  if (state.status === "loading") {
    return <div className="grid gap-2" {...WIDE_POPOVER}>
      <p className="font-medium">Migrate {sandboxName} to the silo account</p>
      <p role="status" className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Checking {sandboxName} and the free space for its backup…</p>
      <div className="flex justify-end">{cancel}</div>
    </div>
  }
  if (state.status === "failed") {
    return <div className="grid gap-2" {...WIDE_POPOVER}>
      <p className="font-medium">Migrate {sandboxName} to the silo account</p>
      <div role="alert" className="text-destructive"><ErrorDetails message={state.message} /></div>
      <div className="flex justify-end gap-2">{cancel}<Button type="button" size="sm" variant="outline" onClick={checkAgain}>Check again</Button></div>
    </div>
  }
  const { plan: value } = state
  const shortfall = value.requiredBytes - value.availableBytes
  const where = computerName ? ` on ${computerName}` : ""
  return <div className="grid gap-2.5" {...WIDE_POPOVER}>
    <p className="font-medium">{value.resume ? `Continue migrating ${sandboxName}` : `Migrate ${sandboxName} to the silo account`}</p>
    <p role="note" className="flex gap-1.5 text-amber-700 dark:text-amber-400">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>This rewrites files inside {sandboxName}: it copies the home folders into /home/silo and changes the owner of every file in /workspace. Silo backs up both disks first and keeps the backup.</span>
    </p>
    <ol aria-label="Migration steps" className="grid list-decimal gap-1 pl-4 text-muted-foreground">
      {value.steps.map((step) => <li key={step}>{step}</li>)}
    </ol>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">Backup</dt>
      <dd>{value.resume ? "The earlier backup is kept and used." : `Up to ${formatSandboxSize(value.backupBytes)}${where}`}</dd>
      <dt className="text-muted-foreground">Location</dt>
      <dd><BackupPath path={value.backupDirectory} /></dd>
      <dt className="text-muted-foreground">Free space</dt>
      <dd className={value.enoughSpace ? undefined : "text-destructive"}>{formatSandboxSize(value.availableBytes)} available{where}, needs about {formatSandboxSize(value.requiredBytes)}</dd>
    </dl>
    {!value.enoughSpace && <p role="alert" className="text-destructive">Not enough free space for the backup. Free up at least {formatSandboxSize(shortfall)}{where}, then check again. Nothing was changed.</p>}
    <div className="flex justify-end gap-2">
      {cancel}
      {value.enoughSpace
        ? <Button type="button" size="sm" autoFocus data-popover-initial-focus="" onClick={migrate}>{value.resume ? "Retry" : "Migrate"}</Button>
        : <Button type="button" size="sm" variant="outline" onClick={checkAgain}>Check again</Button>}
    </div>
  </div>
}

/**
 * What the sandbox page shows for a sandbox on the old account layout, instead of a Start
 * that can only fail: the reason with Migrate, the running step, or the failure with its
 * Details, backup location and Retry.
 */
export function AccountMigrationNotice({ workspace, disabled, disabledReason, plan, onMigrate, onRetry }: {
  workspace: ApplicationWorkspace
  disabled: boolean
  disabledReason?: string
  plan?: () => Promise<AccountMigrationPlan>
  onMigrate?: () => void | Promise<unknown>
  onRetry?: () => void
}) {
  const [open, setOpen] = useState(false)
  const migration = workspace.accountMigration
  if (!migration) return null
  const name = workspace.machine.name
  if (migration.status === "running") {
    return <div role="status" aria-label="Account migration" className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">Moving {name} to the silo account{migration.stage ? `: ${migration.stage}` : ""}…</p>
    </div>
  }
  if (migration.status === "failed") {
    return <div role="alert" aria-label="Account migration failed" className="grid gap-1.5 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="font-medium">The migration to the silo account did not finish.</p>
          <ErrorDetails message={migration.error ?? "The migration stopped."} diagnostic={migration.diagnostic} />
          {migration.backupDirectory
            ? <div className="grid gap-0.5 text-muted-foreground"><span>Backup{workspace.computer ? ` on ${workspace.computer.name}` : ""}. Retry continues with it; keep it until you have checked your files.</span><BackupPath path={migration.backupDirectory} /></div>
            : <p className="text-muted-foreground">No backup was kept. Retry backs up the disks again.</p>}
        </div>
        {onRetry && <DisabledReason reason={disabled ? disabledReason : undefined}><Button type="button" variant="outline" size="xs" className="shrink-0" disabled={disabled} aria-label={`Retry migrating ${name}`} onClick={onRetry}>Retry</Button></DisabledReason>}
      </div>
    </div>
  }
  return <div role="note" aria-label="Old account layout" className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
    <p className="min-w-0 flex-1 break-words">{name} uses the old account layout, so Silo can’t start or open it. Migrate it to the silo account to use it.</p>
    {plan && onMigrate && (disabled
      ? <DisabledReason reason={disabledReason}><Button type="button" variant="outline" size="xs" className="shrink-0" disabled>Migrate…</Button></DisabledReason>
      : <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" className="shrink-0" aria-label={`Migrate ${name} to the silo account`}>Migrate…</Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={8} className="w-96 p-3 text-xs">
        <AccountMigrationBody sandboxName={name} computerName={workspace.computer?.name} plan={plan} onMigrate={onMigrate} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>)}
  </div>
}

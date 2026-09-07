import { Code2, Compass, SquareTerminal } from "lucide-react"

import { ListRow, ListRowIcon } from "@/components/list-row"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"
import { matchesApplication, useApplications, type ApplicationKind } from "@/features/preferences/application-catalog"

const chooseApplication = "__silo-choose-application__"
const unavailableApplication = "__silo-unavailable-application__"
const systemDefaultApplication = "__silo-system-default-application__"

function ApplicationOptionLabel({ kind, name, icon }: { kind: ApplicationKind; name: string; icon?: string }) {
  const Fallback = kind === "terminal" ? SquareTerminal : kind === "editor" ? Code2 : Compass
  return <span className="flex min-w-0 items-center gap-2">
    {icon ? <img src={icon} alt="" aria-hidden="true" draggable={false} className="size-4 shrink-0 object-contain" /> : <Fallback className="size-4 shrink-0" aria-hidden="true" />}
    <span className="truncate">{name}</span>
  </span>
}

function ApplicationPreferenceRow({
  icon: Icon,
  title,
  description,
  control,
  compact,
}: {
  icon: typeof Compass
  title: string
  description: string
  control: React.ReactNode
  compact: boolean
}) {
  return (
    <ListRow
      className={compact ? "hover:bg-muted/35 focus-within:bg-muted/35" : "gap-3 px-0 py-3 first:pt-0 last:pb-0"}
      icon={compact ? <ListRowIcon aria-hidden="true"><Icon className="size-3.5" /></ListRowIcon> : <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      title={<div className={compact ? undefined : "text-sm"}>{title}</div>}
      detail={description}
      detailClassName={compact ? "whitespace-normal" : "mt-0.5 whitespace-normal text-xs"}
      actions={<div className={compact ? "w-40 max-w-[45%] shrink-0" : "w-48 shrink-0"}>{control}</div>}
    />
  )
}

export function ApplicationPreferenceFields({
  value,
  onChange,
  compact = false,
}: {
  value: ApplicationPreferenceSelection
  compact?: boolean
  onChange: (value: ApplicationPreferenceSelection) => void
}) {
  const { catalog, refresh, choose, available } = useApplications()

  async function update(kind: ApplicationKind, selection: string) {
    try {
      if (selection === systemDefaultApplication) {
        onChange({ ...value, [`${kind}UseSystemDefault`]: true })
        return
      }
      const application = selection === chooseApplication
        ? await choose(kind)
        : catalog[kind].find(({ path }) => path === selection)
      if (application) onChange({ ...value, [kind]: application.name, [`${kind}Path`]: application.path, [`${kind}UseSystemDefault`]: false })
    } catch (error) {
      console.error("Silo application selection:", error)
    }
  }

  function applicationSelect(kind: ApplicationKind, label: string) {
    const savedPath = value[`${kind}Path`]
    const selected = catalog[kind].find((application) => savedPath ? application.path === savedPath : matchesApplication(application, value[kind]))
    const useSystemDefault = value[`${kind}UseSystemDefault`] === true
    const systemDefault = catalog[kind].find(({ path }) => path === catalog.defaults[kind])
    return (
      <Select
        value={useSystemDefault ? systemDefaultApplication : selected?.path ?? unavailableApplication}
        onValueChange={(selection) => { void update(kind, selection) }}
        onOpenChange={(open) => { if (open) void refresh().catch((error: unknown) => console.error("Silo application discovery:", error)) }}
      >
        <SelectTrigger className={compact ? "h-7 text-[11px]" : undefined} aria-label={label}>
          <SelectValue>{useSystemDefault ? <ApplicationOptionLabel kind={kind} name={systemDefault ? `${systemDefault.name} (default)` : "System default (not set)"} icon={systemDefault?.icon} /> : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent className="w-max min-w-[var(--radix-select-trigger-width)] max-w-[min(24rem,var(--radix-select-content-available-width))]">
          <SelectItem value={systemDefaultApplication} disabled={!systemDefault}><ApplicationOptionLabel kind={kind} name={`System default (${systemDefault?.name ?? "not set"})`} icon={systemDefault?.icon} /></SelectItem>
          {!useSystemDefault && !selected && <SelectItem value={unavailableApplication} disabled><ApplicationOptionLabel kind={kind} name={`${value[kind]} (unavailable)`} /></SelectItem>}
          {catalog[kind].map((application) => <SelectItem key={application.path} value={application.path}><ApplicationOptionLabel kind={kind} name={application.name} icon={application.icon} /></SelectItem>)}
          <SelectItem value={chooseApplication} disabled={!available}>Choose…</SelectItem>
        </SelectContent>
      </Select>
    )
  }

  return (
    <>
      <ApplicationPreferenceRow
        compact={compact}
        icon={SquareTerminal}
        title="Terminal"
        description="Used by sandbox terminal shortcuts."
        control={applicationSelect("terminal", "Terminal")}
      />
      <ApplicationPreferenceRow
        compact={compact}
        icon={Code2}
        title="Code editor"
        description="Used when opening sandbox files."
        control={applicationSelect("editor", "Code editor")}
      />
      <ApplicationPreferenceRow
        compact={compact}
        icon={Compass}
        title="Browser"
        description="Used when opening sandbox URLs."
        control={applicationSelect("browser", "Browser")}
      />
    </>
  )
}

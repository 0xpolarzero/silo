import { useRef, useState, type ReactNode } from "react"
import { ChevronRight, CircleAlert, Code, ExternalLink, Globe, Loader2, Monitor, MoreHorizontal, PanelTop, Play, Power, RotateCw, Server, Square, Terminal } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { CopyButton } from "@/components/copy-button"
import { ListCard, ListRow, ListRowDetails, ListRowIcon } from "@/components/list-row"
import { SiloMark } from "@/components/silo-mark"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkspaceStateLabel } from "@/features/application/components/application-ui"
import type { ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"
import { SandboxAction, SandboxListItem, SandboxListRow } from "@/features/sandboxes/components/sandbox-list"
import { SecretChangesLabel } from "@/features/sandboxes/components/secret-changes-label"
import { workspaceIconState, workspaceRowTone } from "@/features/sandboxes/model/workspace-presentation"
import { cn } from "@/lib/utils"
import { statusBarHealth, statusWorkspaceAvailability } from "./status-bar-model"
import type { StatusBarActions } from "./status-bar-types"
import { StatusFolderPicker } from "./status-folder-picker"

const menuClass = "silo-window z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
const menuItemClass = "flex min-h-8 select-none items-center gap-2 rounded-sm px-2 text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

function MenuItem({ children, icon, onSelect, disabled }: { children: ReactNode; icon: ReactNode; onSelect: () => void; disabled?: boolean }) {
  return <DropdownMenu.Item className={menuItemClass} disabled={disabled} onSelect={onSelect}>{icon}{children}</DropdownMenu.Item>
}

function WorkspaceMenu({ workspace, source, actions, onFolders, onConfirm }: {
  workspace: ApplicationWorkspace
  source: ApplicationSource
  actions: StatusBarActions
  onFolders: () => void
  onConfirm: (action: "stop" | "restart") => void
}) {
  const { machine } = workspace
  const { canOpen, canStart, canStop, canRestart } = statusWorkspaceAvailability(workspace, source)
  const sites = workspace.ports.filter(({ listening }) => listening === true).sort((a, b) => a.port - b.port)
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${machine.name}`}><MoreHorizontal /></Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuClass} data-reduce-motion={source.preferences.reduceMotion} align="end" sideOffset={4} collisionPadding={10} aria-label={`Actions for ${machine.name}`}>
          {workspace.state === "stopped" && <MenuItem icon={<Play />} disabled={!canStart} onSelect={() => actions.startWorkspace(machine.name)}>Start</MenuItem>}
          {workspace.state !== "stopped" && <>
            <MenuItem icon={<Square />} disabled={!canStop} onSelect={() => onConfirm("stop")}>Stop…</MenuItem>
            <MenuItem icon={<RotateCw />} disabled={!canRestart} onSelect={() => onConfirm("restart")}>Restart…</MenuItem>
          </>}
          <DropdownMenu.Separator className="my-1 border-t" />
          <MenuItem icon={<Terminal />} disabled={!canOpen} onSelect={() => actions.openTerminal(machine.name)}>Open in {source.preferences.terminal}</MenuItem>
          <MenuItem icon={<Code />} disabled={!canOpen} onSelect={onFolders}>Open in {source.preferences.editor}…</MenuItem>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={menuItemClass} disabled={!canOpen || !workspace.host}><Globe /> Open site <ChevronRight className="ml-auto" /></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className={menuClass} data-reduce-motion={source.preferences.reduceMotion} sideOffset={4} collisionPadding={10}>
                {sites.length ? sites.map(({ port }) => <MenuItem key={port} icon={<ExternalLink />} onSelect={() => actions.openSite(machine.name, port)}>Port {port}</MenuItem>) : <DropdownMenu.Item disabled className={menuItemClass}>No active sites</DropdownMenu.Item>}
                <DropdownMenu.Separator className="my-1 border-t" />
                <DropdownMenu.Item asChild onSelect={(event) => event.preventDefault()}>
                  <CopyButton
                    value={`http://${workspace.host}`}
                    labels={{ idle: "Copy base URL", copied: "Base URL copied", failed: "Couldn't copy base URL" }}
                    text={{ idle: "Copy base URL", copied: "Copied", failed: "Copy failed" }}
                    variant="ghost"
                    size="sm"
                    className={cn(menuItemClass, "w-full justify-start font-normal")}
                  />
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function OperationIssue({ title, detail, actionLabel, onReview }: { title: string; detail: string; actionLabel: string; onReview: () => void }) {
  return (
    <ListCard className="mb-2" role="alert" aria-label={title}>
      <ListRow
        icon={<ListRowIcon className="bg-destructive/10 text-destructive"><CircleAlert className="size-3.5" aria-hidden="true" /></ListRowIcon>}
        title={title}
        detail={detail}
        detailClassName="whitespace-normal break-words"
        actions={<Button variant="outline" size="xs" aria-label={actionLabel} onClick={onReview}>Details</Button>}
      />
    </ListCard>
  )
}

function StatusBarContent({ source, actions, focusContent }: { source: ApplicationSource; actions: StatusBarActions; focusContent: () => void }) {
  const [folderWorkspace, setFolderWorkspace] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ workspace: string; action: "stop" | "restart" } | null>(null)
  const repair = source.runtimeRepair && source.runtimeRepair.status !== "succeeded" ? source.runtimeRepair : null
  const folders = source.workspaces.find(({ machine }) => machine.id === folderWorkspace)
  const failedPushes = source.repositoryPushOperations.filter((operation) => operation.status === "failed")
  const failedConfiguration = source.sandboxConfigurationOperation?.status === "failed" ? source.sandboxConfigurationOperation : null
  const stale = source.workspaces.some(({ freshness }) => freshness === "stale")

  if (folders && statusWorkspaceAvailability(folders, source).canOpen) {
    return <StatusFolderPicker workspace={folders} editor={source.preferences.editor} onBack={() => { setFolderWorkspace(null); focusContent() }} onOpen={(path) => actions.openEditor(folders.machine.name, path)} />
  }

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <SiloMark className="size-4" />
        <h1 className="flex-1 text-sm font-semibold">Silo</h1>
        {stale && <SandboxAction label="Retry sandbox status" onClick={actions.refresh}><RotateCw /></SandboxAction>}
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        {repair && <ListCard className="mb-2">
          <ListRow
            icon={<ListRowIcon className={repair.status === "repairing" ? undefined : "bg-destructive/10 text-destructive"}>{repair.status === "repairing" ? <Loader2 className="size-3.5 animate-spin" /> : <CircleAlert className="size-3.5" />}</ListRowIcon>}
            title={repair.status === "repairing" ? "Repairing Silo…" : "Silo needs repair"}
            detail={repair.status === "repairing" ? "Sandboxes will be available shortly" : "The Silo runtime needs attention"}
            actions={<Button variant="outline" size="xs" onClick={() => actions.openSilo({ tab: "system" })}>{repair.status === "repairing" ? "View" : "Repair…"}</Button>}
          />
        </ListCard>}
        {failedConfiguration && <OperationIssue
          title="Sandbox changes failed"
          detail={failedConfiguration.error.message}
          actionLabel="Review sandbox changes"
          onReview={() => actions.openSilo({ workspaceSection: "overview" })}
        />}
        {failedPushes.map((operation) => <OperationIssue
          key={`${operation.workspace}:${operation.repositoryPath}`}
          title={`Push failed · ${operation.workspace}`}
          detail={`${operation.repositoryPath} · ${operation.message}`}
          actionLabel={`Review push failure for ${operation.workspace}, ${operation.repositoryPath}`}
          onReview={() => actions.openSilo({ workspace: operation.workspace, workspaceSection: "files" })}
        />)}
        {source.workspaces.length ? <ListCard>
          <ol aria-label="Sandboxes" className="divide-y">
            {source.workspaces.map((workspace) => {
              const { machine } = workspace
              const availability = statusWorkspaceAvailability(workspace, source)
              const pending = confirmation?.workspace === machine.name ? confirmation : null
              const pendingSecrets = machine.kind === "vm" ? source.secrets.filter((secret) => secret.state === "restart-required" && secret.workspaces.includes(machine.name)).map(({ name }) => name) : []
              const activity = source.activities.find((item) => item.category === "sandbox" && item.workspace === machine.name && item.status === "running")
              const review = workspace.state === "failed" || workspace.attention?.level === "error"
              const detail = workspace.attention?.message ?? (workspace.state === "failed" ? workspace.stateDetail : workspace.freshness === "stale" ? "Last known status" : undefined)
              return <SandboxListItem key={machine.id} aria-label={machine.name} aria-busy={availability.busy || undefined}>
                <SandboxListRow
                  name={machine.name}
                  kind={machine.kind}
                  iconState={workspaceIconState(workspace)}
                  tone={workspace.freshness === "stale" ? "warning" : workspaceRowTone(workspace)}
                  icon={availability.busy ? <span className="relative shrink-0">
                    <ListRowIcon>{machine.kind === "vm" ? <Monitor className="size-3.5" /> : <Server className="size-3.5" />}</ListRowIcon>
                    <span className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background"><Loader2 className="size-2.5 animate-spin" aria-hidden="true" /></span>
                  </span> : undefined}
                  detail={<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="truncate" title={availability.busy ? activity?.title ?? workspace.stateDetail : detail}>
                      {availability.busy ? <span className="font-medium text-amber-700 dark:text-amber-400">{activity?.title ?? (workspace.state === "starting" ? workspace.stateDetail : "Working…")}</span> : <><WorkspaceStateLabel state={workspace.state} />{detail && <span> · {detail}</span>}</>}
                    </span>
                    {pendingSecrets.length > 0 && <SecretChangesLabel workspace={machine.name} state={workspace.state} secrets={pendingSecrets} />}
                  </span>}
                  detailClassName="overflow-visible whitespace-normal"
                  actions={<>
                    {!availability.busy && !repair && (review
                      ? <SandboxAction label={`See logs for ${machine.name}`} onClick={() => actions.openSilo({ workspace: machine.name, workspaceSection: "logs" })}><Terminal /></SandboxAction>
                      : workspace.freshness === "stale" ? <SandboxAction label={`Retry ${machine.name} status`} onClick={actions.refresh}><RotateCw /></SandboxAction>
                        : availability.canOpen ? <>
                          <SandboxAction label={`Open ${machine.name} in ${source.preferences.terminal}`} onClick={() => actions.openTerminal(machine.name)}><Terminal /></SandboxAction>
                          <SandboxAction label={`Open ${machine.name} in ${source.preferences.editor}`} onClick={() => setFolderWorkspace(machine.id)}><Code /></SandboxAction>
                        </> : availability.canStart ? <SandboxAction label={`Start ${machine.name}`} onClick={() => actions.startWorkspace(machine.name)}><Play /></SandboxAction>
                          : <SandboxAction label={`Open ${machine.name} in Silo`} onClick={() => actions.openSilo({ workspace: machine.name })}><PanelTop /></SandboxAction>)}
                    <WorkspaceMenu workspace={workspace} source={source} actions={actions} onFolders={() => setFolderWorkspace(machine.id)} onConfirm={(action) => setConfirmation({ workspace: machine.name, action })} />
                  </>}
                />
                {pending && <ListRowDetails label={`${pending.action === "stop" ? "Stop" : "Restart"} ${machine.name}?`} className="gap-2 pl-0">
                  <p className="text-[11px] text-muted-foreground">{pending.action === "stop" ? "Stop" : "Restart"} {machine.name}? Running processes will be interrupted.</p>
                  <div className="flex justify-end gap-1.5">
                    <Button variant="ghost" size="xs" onClick={() => setConfirmation(null)}>Cancel</Button>
                    <Button variant="destructive" size="xs" disabled={pending.action === "stop" ? !availability.canStop : !availability.canRestart} onClick={() => {
                      if (pending.action === "stop" ? !availability.canStop : !availability.canRestart) return
                      setConfirmation(null)
                      if (pending.action === "stop") actions.stopWorkspace(machine.name)
                      else actions.restartWorkspace(machine.name)
                    }}>{pending.action === "stop" ? <Square /> : <RotateCw />}{pending.action === "stop" ? "Stop" : "Restart"}</Button>
                  </div>
                </ListRowDetails>}
              </SandboxListItem>
            })}
          </ol>
        </ListCard> : <div className="grid justify-items-center gap-1.5 py-8 text-center">
          <ListRowIcon><Monitor className="size-3.5" /></ListRowIcon>
          <p className="text-[13px] font-medium">No sandboxes yet</p>
          <p className="text-[11px] text-muted-foreground">Add your first sandbox in Silo.</p>
        </div>}
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t px-2 py-2">
        <Button variant="ghost" size="sm" onClick={() => actions.openSilo()}><PanelTop data-icon="inline-start" /> Open Silo…</Button>
        <SandboxAction label="Quit Silo" onClick={actions.quit}><Power /></SandboxAction>
      </footer>
    </>
  )
}

export function StatusBar({ source, actions, defaultOpen = false }: { source: ApplicationSource; actions: StatusBarActions; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const content = useRef<HTMLDivElement>(null)
  const health = statusBarHealth(source)
  function dismissThen(action: () => void) { setOpen(false); action() }
  const dismissingActions: StatusBarActions = {
    ...actions,
    openSilo: (route) => dismissThen(() => actions.openSilo(route)),
    quit: () => dismissThen(actions.quit),
    openTerminal: (name) => dismissThen(() => actions.openTerminal(name)),
    openEditor: (name, path) => dismissThen(() => actions.openEditor(name, path)),
    openSite: (name, port) => dismissThen(() => actions.openSite(name, port)),
  }
  return (
    <TooltipProvider delayDuration={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="relative rounded-md" aria-label="Silo status bar" title={`Silo · ${health.label}`}>
            <SiloMark className="size-4" />
            {(health.tone === "error" || health.tone === "warning") && <span className={cn("absolute top-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-background", health.tone === "error" ? "bg-destructive" : "bg-amber-500")} aria-hidden="true" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={content}
          aria-label="Silo"
          align="end"
          sideOffset={8}
          collisionPadding={10}
          className="silo-window flex max-h-[min(520px,var(--radix-popover-content-available-height))] w-[380px] max-w-[calc(100vw-20px)] flex-col overflow-hidden rounded-xl p-0 shadow-lg"
          data-reduce-motion={source.preferences.reduceMotion}
          onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus() }}
        >
          <StatusBarContent source={source} actions={dismissingActions} focusContent={() => content.current?.focus()} />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

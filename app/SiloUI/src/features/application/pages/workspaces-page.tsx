import { NetworkPage } from "./network-page"
import { FolderActions } from "@/features/application/components/folder-actions"
import { WorkspaceFileTree } from "@/features/application/components/workspace-file-tree"
import type { createDirectoryStore } from "@/features/application/model/directory-store"
import { useMemo, useState } from "react"
import { Activity, Archive, Box, Check, CircleAlert, Cloud, GitBranch, KeyRound, Loader2, Search, TriangleAlert, Wrench } from "lucide-react"

import { CopyButton } from "@/components/copy-button"
import { DisclosureHeader } from "@/components/disclosure-header"
import { FilterCombobox, type FilterOption } from "@/components/filter-combobox"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RepositoryPushFeedback } from "@/features/application/components/repository-push-feedback"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import type { ApplicationActions, ApplicationSource, ApplicationActivity, ApplicationActivityCategory, ApplicationWorkspace, RepositoryPushOperation, WorkspaceDetailSection } from "@/features/application/model/application-source"
import { commitLabel } from "@/features/application/model/repository-push"
import { cn } from "@/lib/utils"

function WorkspaceFilterBar({
  workspaces,
  selectedWorkspaceIds,
  onChange,
}: {
  workspaces: ApplicationWorkspace[]
  selectedWorkspaceIds: ReadonlySet<string>
  onChange: (selectedWorkspaceIds: Set<string>) => void
}) {
  return (
    <div className="border-b border-border pb-4">
      <FilterCombobox
        options={workspaces.map(({ machine }) => ({ value: machine.id, label: machine.name }))}
        selectedValues={selectedWorkspaceIds}
        onChange={onChange}
        label="Sandbox filters"
        inputLabel="Filter sandboxes"
        placeholder="Filter sandboxes…"
        listLabel="Available sandbox filters"
        selectedLabel="Selected sandboxes"
        emptyMessage="No sandboxes available."
      />
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-border px-6 text-center">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function Files({
  workspaces,
  repositoryPushOperations,
  onPushRepository,
  onDismissRepositoryPush,
  editor,
  onOpenEditor,
  directoryStore,
  active,
}: {
  editor: string
  onOpenEditor: (workspace: string, path: string) => void
  directoryStore: ReturnType<typeof createDirectoryStore>
  active: boolean
  workspaces: ApplicationWorkspace[]
  repositoryPushOperations: RepositoryPushOperation[]
  onPushRepository: (workspace: string, repositoryPath: string, commitCount: number) => void
  onDismissRepositoryPush: (workspace: string, repositoryPath: string) => void
}) {
  const [repositoriesOpen, setRepositoriesOpen] = useState(true)
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  if (workspaces.length === 0) return <EmptyState title="No sandboxes selected" description="Select at least one sandbox to browse its files and repositories." />
  const repositories = workspaces.flatMap((workspace) => workspace.repositories.map((repository) => ({ workspace, repository })))
  const pushOperations = new Map(repositoryPushOperations.map((operation) => [`${operation.workspace}:${operation.repositoryPath}`, operation]))

  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-3 lg:grid lg:grid-cols-2 lg:grid-rows-1 lg:content-stretch lg:gap-0" data-files-layout data-file-tree-state={fileTreeOpen ? "open" : "closed"}>
      <Collapsible
        asChild
        open={repositoriesOpen}
        onOpenChange={setRepositoriesOpen}
      >
        <section
          aria-label="Repositories"
          className={cn(
            "collapsible-motion flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden transition-[max-height] duration-200 ease-out lg:h-full lg:max-h-none lg:pr-5 lg:transition-none",
            repositoriesOpen ? fileTreeOpen ? "max-h-[50%] shrink-0" : "flex-1" : "max-h-8 shrink-0",
          )}
          data-files-pane="repositories"
          data-pane-position="top"
        >
          <DisclosureHeader
            className="h-8 shrink-0 px-2 py-0"
            title="Repositories"
            titleClassName="text-sm font-medium"
            label={`${repositoriesOpen ? "Collapse" : "Expand"} repositories`}
            controlsLabel="Repository pane controls"
          />
          <CollapsibleContent className="file-pane-content-motion min-h-0 flex-1" data-files-pane-content="repositories">
            <div className="h-full overflow-y-auto overscroll-contain px-2 pt-2" data-files-pane-scroll="repositories">
              {repositories.length > 0 ? (
                <ListCard divided role="list" aria-label="Repositories">
                  {repositories.map(({ workspace, repository }) => {
                    const operation = pushOperations.get(`${workspace.machine.name}:${repository.path}`)
                    const push = () => onPushRepository(workspace.machine.name, repository.path, operation?.commitCount ?? repository.ahead)
                    return (
                      <div key={`${workspace.machine.id}:${repository.path}`} role="listitem" aria-busy={operation?.status === "pushing" || undefined} className="group/folder transition-colors hover:bg-muted/35 focus-within:bg-muted/35">
                        <ListRow
                          data-repository-header
                          icon={<ListRowIcon aria-hidden="true"><GitBranch className="size-3.5" /></ListRowIcon>}
                          title={<TooltipProvider delayDuration={150}><Tooltip>
                            <TooltipTrigger asChild><span className="truncate" tabIndex={0}>{repository.path.split("/").filter(Boolean).at(-1) ?? repository.path}</span></TooltipTrigger>
                            <TooltipContent className="max-w-sm break-all">{repository.path}</TooltipContent>
                          </Tooltip></TooltipProvider>}
                          detail={`${repository.branch} · ${repository.ahead} ahead, ${repository.behind} behind`}
                          actions={<><FolderActions editor={editor} path={repository.path} onOpen={() => onOpenEditor(workspace.machine.name, repository.path)} disabled={workspace.state !== "running" || workspace.freshness !== "fresh"} /><WorkspaceBadge name={workspace.machine.name} state={workspace.state} /></>}
                        />
                        {(operation || repository.ahead > 0) && (
                          <div className="flex min-h-6 items-start pr-2 pb-2 pl-10" data-repository-actions>
                            {operation
                              ? <RepositoryPushFeedback operation={operation} workspace={workspace.machine.name} repositoryPath={repository.path} onRetry={push} onDismiss={onDismissRepositoryPush} />
                              : <Button variant="outline" size="xs" onClick={push}>Push {commitLabel(repository.ahead)}</Button>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </ListCard>
              ) : <p className="text-xs text-muted-foreground">No repositories checked out.</p>}
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>

      <Collapsible
        asChild
        open={fileTreeOpen}
        onOpenChange={setFileTreeOpen}
      >
        <section
          aria-label="File tree"
          className={cn(
            "collapsible-motion flex min-h-0 min-w-0 max-h-full flex-1 flex-col overflow-hidden transition-[max-height] duration-200 ease-out lg:h-full lg:max-h-none lg:border-l lg:border-border lg:pl-5 lg:transition-none",
            !fileTreeOpen && "max-h-8",
          )}
          data-files-pane="file-tree"
          data-pane-position="bottom"
        >
          <DisclosureHeader
            className="h-8 shrink-0 px-2 py-0"
            title="File tree"
            titleClassName="text-sm font-medium"
            label={`${fileTreeOpen ? "Collapse" : "Expand"} file tree`}
            controlsLabel="File tree pane controls"
          />
          <CollapsibleContent className="file-pane-content-motion min-h-0 flex-1" data-files-pane-content="file-tree">
            <div className="h-full overflow-y-auto overscroll-contain px-2 pt-2" data-files-pane-scroll="file-tree">
              <ul className="grid gap-0.5" aria-label="File tree">
                {workspaces.map((workspace) => <WorkspaceFileTree editor={editor} key={workspace.machine.id} workspace={workspace} store={directoryStore} active={active} onOpenEditor={onOpenEditor} />)}
              </ul>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>
    </div>
  )
}

interface LogRow {
  id: string
  raw: string
  occurredAt: string
  timestamp: string
  workspace: string
  workspaceState: ApplicationWorkspace["state"]
  message: string
}

function logRows(workspaces: ApplicationWorkspace[]): LogRow[] {
  return workspaces.flatMap((workspace) => workspace.logs.map((log, index) => {
    const match = /^(\d{2}:\d{2}:\d{2})\s{2,}(.*)$/.exec(log.line)
    return {
      id: `${workspace.machine.id}:${index}`,
      raw: log.line,
      occurredAt: log.occurredAt,
      timestamp: match?.[1] ?? new Date(log.occurredAt).toLocaleTimeString(),
      workspace: workspace.machine.name,
      workspaceState: workspace.state,
      message: match?.[2] ?? log.line,
    }
  })).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
}

function Logs({ workspaces, query, onQueryChange }: { workspaces: ApplicationWorkspace[]; query: string; onQueryChange: (query: string) => void }) {
  if (workspaces.length === 0) return <EmptyState title="No sandboxes selected" description="Select at least one sandbox to see its logs." />
  const rows = logRows(workspaces)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRows = rows.filter((row) => !normalizedQuery || `${row.timestamp} ${row.workspace} ${row.message}`.toLowerCase().includes(normalizedQuery))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search logs" placeholder="Search logs" value={query} onChange={(event) => onQueryChange(event.target.value)} className="h-7 pl-8" />
        </div>
        <CopyButton
          variant="outline"
          size="sm"
          className="has-data-[icon=inline-start]:pl-2.5"
          value={filteredRows.map(({ raw }) => raw).join("\n")}
          disabled={filteredRows.length === 0}
          labels={{ idle: "Copy all logs", copied: "All logs copied", failed: "Copy all logs failed" }}
          text={{ idle: "Copy all", copied: "Copied", failed: "Copy failed" }}
        />
      </div>
      {filteredRows.length > 0 ? (
        <div role="table" aria-label="Logs" className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border text-xs">
          <div role="row" className="grid shrink-0 grid-cols-[5.5rem_minmax(0,1fr)_7rem_1.5rem] gap-3 border-b border-border bg-muted/45 px-3 py-2 font-medium text-muted-foreground">
            <span role="columnheader">Time</span>
            <span role="columnheader">Message</span>
            <span role="columnheader">Sandbox</span>
            <span role="columnheader" className="sr-only">Actions</span>
          </div>
          <div className="min-h-0 divide-y divide-border overflow-y-auto overscroll-contain bg-card" data-table-scroll="logs">
            {filteredRows.map((row) => (
              <div key={row.id} role="row" className="group/log-row grid grid-cols-[5.5rem_minmax(0,1fr)_7rem_1.5rem] items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/55 focus-within:bg-muted/55">
                <span role="cell" className="font-mono text-muted-foreground">{row.timestamp}</span>
                <span role="cell" className="min-w-0 break-words font-mono text-foreground/85">{row.message}</span>
                <span role="cell" className="flex items-center"><WorkspaceBadge name={row.workspace} state={row.workspaceState} /></span>
                <span role="cell">
                  <CopyButton
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 transition-opacity group-hover/log-row:opacity-100 group-focus-within/log-row:opacity-100 focus-visible:opacity-100"
                    value={row.raw}
                    labels={{ idle: `Copy log line from ${row.workspace} at ${row.timestamp}`, copied: "Log line copied", failed: "Copy log line failed" }}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : <EmptyState title={normalizedQuery ? "No matching logs" : "No logs yet"} description={normalizedQuery ? `No logs match “${query}”.` : "Logs from the selected sandboxes will appear here."} />}
    </div>
  )
}

const activityCategoryOptions: ReadonlyArray<FilterOption<ApplicationActivityCategory>> = [
  { value: "sandbox", label: "Sandbox" },
  { value: "git", label: "Git" },
  { value: "backup", label: "Backup" },
  { value: "secrets", label: "Secrets" },
  { value: "github", label: "GitHub" },
  { value: "system", label: "System" },
]

const activityCategoryPresentation = {
  sandbox: { label: "Sandbox", icon: Box },
  git: { label: "Git", icon: GitBranch },
  backup: { label: "Backup", icon: Archive },
  secrets: { label: "Secrets", icon: KeyRound },
  github: { label: "GitHub", icon: Cloud },
  system: { label: "System", icon: Wrench },
} as const

function ActivityLog({ workspaces, sourceActivities }: { workspaces: ApplicationWorkspace[]; sourceActivities: ApplicationActivity[] }) {
  const [selectedCategories, setSelectedCategories] = useState<Set<ApplicationActivityCategory>>(() => new Set())
  const workspacesByName = new Map(workspaces.map((workspace) => [workspace.machine.name, workspace]))
  const allActivities = [...sourceActivities]
    .filter(({ workspace }) => !workspace || workspacesByName.has(workspace))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  const activities = selectedCategories.size === 0
    ? allActivities
    : allActivities.filter(({ category }) => selectedCategories.has(category))

  if (workspaces.length === 0 && allActivities.length === 0) return <EmptyState title="No recent activity" description="Sandbox and system activity will appear here." />

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <FilterCombobox
        options={activityCategoryOptions}
        selectedValues={selectedCategories}
        onChange={setSelectedCategories}
        label="Activity category filters"
        inputLabel="Add category filter"
        placeholder="Add category…"
        listLabel="Available activity categories"
        selectedLabel="Selected activity categories"
        emptyMessage="No categories available."
        compact
        className="w-full shrink-0"
      />

      {activities.length > 0 ? (
        <ListCard divided className="max-h-full min-h-0 overflow-y-auto overscroll-contain" role="list" aria-label="Recent activity">
          {activities.map((item) => {
            const category = activityCategoryPresentation[item.category]
            const CategoryIcon = category.icon
            const workspace = item.workspace ? workspacesByName.get(item.workspace) : undefined
            return (
              <ListRow
                key={item.id}
                role="listitem"
                aria-busy={item.status === "running" || undefined}
                data-activity-id={item.id}
                data-activity-status={item.status}
                className={cn(
                  "hover:bg-muted/35",
                  item.status === "running" && "bg-primary/[0.025]",
                  item.tone === "warning" && "bg-amber-500/[0.035]",
                  item.tone === "danger" && "bg-destructive/[0.025]",
                )}
                icon={
                  <ListRowIcon aria-hidden="true" className={cn(
                    item.tone === "success" && "bg-emerald-500/10",
                    item.tone === "warning" && "bg-amber-500/10",
                    item.tone === "danger" && "bg-destructive/10",
                  )}>
                    {item.status === "running"
                      ? <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
                      : item.tone === "danger"
                        ? <CircleAlert className="size-3.5 text-destructive" />
                        : item.tone === "warning"
                          ? <TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
                          : item.tone === "success"
                            ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                            : <Activity className="size-3.5" />}
                  </ListRowIcon>
                }
                title={<div className="min-w-0 break-words">{item.title}</div>}
                detailClassName="whitespace-normal"
                detail={
                  <div className="min-w-0 space-y-1" data-activity-content>
                    <p>{item.detail}</p>
                    {item.status === "running" && item.progress !== undefined && (
                      <div className="flex max-w-sm items-center gap-2 pt-1">
                        <Progress value={item.progress * 100} aria-label={item.progressLabel ?? `${item.title} progress`} />
                        <span className="w-8 shrink-0 text-right text-[10px] tabular-nums">{Math.round(item.progress * 100)}%</span>
                      </div>
                    )}
                  </div>
                }
                actions={
                  <div className="flex max-w-[40%] shrink-0 flex-col items-end gap-1" data-activity-meta>
                    <time dateTime={item.occurredAt} className="text-[10px] text-muted-foreground">{new Date(item.occurredAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}</time>
                    <div className="flex flex-wrap justify-end gap-1">
                      {item.workspace && workspace && <WorkspaceBadge name={item.workspace} state={workspace.state} />}
                      <StatusBadge indicator={<CategoryIcon className="size-2.5" />} aria-label={`Category: ${category.label}`}>{category.label}</StatusBadge>
                    </div>
                  </div>
                }
              />
            )
          })}
        </ListCard>
      ) : (
        <EmptyState
          title={allActivities.length === 0 ? "No recent activity" : "No matching activity"}
          description={allActivities.length === 0 ? "Activity from these sandboxes will appear here." : "Clear the category filters to show all activity."}
        />
      )}
    </div>
  )
}

export function WorkspacesPage({
  network, networkError, networkActions,
  editor,
  onOpenEditor,
  directoryStore,
  active,
  workspaces,
  activities,
  selectedWorkspaceIds,
  section,
  logQuery,
  repositoryPushOperations,
  browser,
  onWorkspaceFilterChange,
  onLogQueryChange,
  onPushRepository,
  onDismissRepositoryPush,
}: {
  network?: ApplicationSource["network"]
  networkError?: string | null
  networkActions: ApplicationActions
  editor: string
  onOpenEditor: (workspace: string, path: string) => void
  directoryStore: ReturnType<typeof createDirectoryStore>
  active: boolean
  workspaces: ApplicationWorkspace[]
  activities: ApplicationActivity[]
  selectedWorkspaceIds: ReadonlySet<string>
  section: WorkspaceDetailSection
  logQuery: string
  repositoryPushOperations: RepositoryPushOperation[]
  browser: string
  onWorkspaceFilterChange: (selectedWorkspaceIds: Set<string>) => void
  onLogQueryChange: (query: string) => void
  onPushRepository: (workspace: string, repositoryPath: string, commitCount: number) => void
  onDismissRepositoryPush: (workspace: string, repositoryPath: string) => void
}) {
  const visibleWorkspaces = useMemo(
    () => selectedWorkspaceIds.size === 0 ? workspaces : workspaces.filter(({ machine }) => selectedWorkspaceIds.has(machine.id)),
    [workspaces, selectedWorkspaceIds],
  )

  return (
    <div className="mx-auto grid h-full min-h-0 w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden px-4 py-5 sm:px-6 sm:py-6">
      <WorkspaceFilterBar workspaces={workspaces} selectedWorkspaceIds={selectedWorkspaceIds} onChange={onWorkspaceFilterChange} />
      {section === "files" && <Files editor={editor} onOpenEditor={onOpenEditor} directoryStore={directoryStore} active={active} workspaces={visibleWorkspaces} repositoryPushOperations={repositoryPushOperations} onPushRepository={onPushRepository} onDismissRepositoryPush={onDismissRepositoryPush} />}
      {section === "logs" && <Logs workspaces={visibleWorkspaces} query={logQuery} onQueryChange={onLogQueryChange} />}
      {section === "network" && <NetworkPage workspaces={visibleWorkspaces} browser={browser} network={network} error={networkError} actions={networkActions} active={active} />}
      {section === "activity" && <ActivityLog workspaces={visibleWorkspaces} sourceActivities={activities} />}
    </div>
  )
}

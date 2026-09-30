import { Logs, type LogWindow } from "./logs-page"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import { NetworkPage } from "./network-page"
import { FolderActions } from "@/features/application/components/folder-actions"
import { WorkspaceFileTree } from "@/features/application/components/workspace-file-tree"
import type { createDirectoryStore } from "@/features/application/model/directory-store"
import { useMemo, useState } from "react"
import { Activity, Archive, Box, Boxes, Check, CircleAlert, Cloud, File, GitBranch, KeyRound, Loader2, Plus, RefreshCw, TriangleAlert, Wrench } from "lucide-react"

import { DisclosureHeader } from "@/components/disclosure-header"
import { EmptyState } from "@/components/empty-state"
import { ErrorDetails } from "@/components/error-details"
import { FilterCombobox, type FilterOption } from "@/components/filter-combobox"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RepositoryPushFeedback, useRepositoryPushToasts } from "@/features/application/components/repository-push-feedback"
import { WorkspaceBadge } from "@/features/application/components/application-ui"
import type { ApplicationActions, ApplicationSource, ApplicationActivity, ApplicationActivityCategory, ApplicationWorkspace, RepositoryPushOperation, WorkspaceDetailSection } from "@/features/application/model/application-source"
import { commitLabel } from "@/features/application/model/repository-push"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import { showActionFailure } from "@/lib/operation-toast"
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
        className="[&_input]:h-7"
        placeholder="Filter sandboxes…"
        listLabel="Available sandbox filters"
        selectedLabel="Selected sandboxes"
        emptyMessage="No sandboxes available."
      />
    </div>
  )
}

function Files({
  source,
  onRefreshRepositories,
  workspaces,
  repositoryPushOperations,
  onPushRepository,
  onDismissRepositoryPush,
  editor,
  onOpenEditor,
  directoryStore,
  active,
}: {
  source: ApplicationSource
  onRefreshRepositories?: () => Promise<void>
  editor: string
  onOpenEditor: (workspace: string, path: string) => void
  directoryStore: ReturnType<typeof createDirectoryStore>
  active: boolean
  workspaces: ApplicationWorkspace[]
  repositoryPushOperations: RepositoryPushOperation[]
  onPushRepository: (workspace: string, repositoryPath: string, commitCount: number) => void
  onDismissRepositoryPush: (workspace: string, repositoryPath: string) => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const refreshRepositories = async () => {
    if (!onRefreshRepositories || refreshing) return
    setRefreshing(true)
    try { await onRefreshRepositories() }
    catch (error) { showActionFailure("Could not refresh repositories", error, () => void refreshRepositories(), { native: false }) }
    finally { setRefreshing(false) }
  }
  const [repositoriesOpen, setRepositoriesOpen] = useState(true)
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  if (workspaces.length === 0) return <EmptyState icon={<File />} title="No matching sandboxes" description="Clear the sandbox filter to browse files and repositories in every sandbox." />
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
            actions={<Button variant="ghost" size="icon" className="size-6" aria-label="Refresh repositories" title="Refresh repositories" disabled={refreshing || !onRefreshRepositories} onClick={() => void refreshRepositories()}><RefreshCw aria-hidden="true" className={cn("size-3.5", refreshing && "motion-safe:animate-spin")} /></Button>}
            controlsLabel="Repository pane controls"
          />
          <CollapsibleContent className="file-pane-content-motion min-h-0 flex-1" data-files-pane-content="repositories">
            <div className="h-full overflow-y-auto overscroll-contain px-2 pt-2" data-files-pane-scroll="repositories">
              {repositories.length > 0 ? (
                <ListCard divided role="list" aria-label="Repositories">
                  {repositories.map(({ workspace, repository }) => {
                    const operation = pushOperations.get(`${workspaceTarget(workspace)}:${repository.path}`)
                    const push = () => onPushRepository(workspaceTarget(workspace), repository.path, operation?.commitCount ?? repository.ahead)
                    // Same gate and name as the status bar: identical buttons need the repository and sandbox.
                    const canPush = workspaceAvailability(workspace, source).canOpen
                    const sandbox = workspace.computer ? `${workspace.machine.name} on ${workspace.computer.name}` : workspace.machine.name
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
                          actions={<><FolderActions editor={editor} path={repository.path} onOpen={() => onOpenEditor(workspaceTarget(workspace), repository.path)} disabled={workspace.state !== "running" || workspace.freshness !== "fresh"} /><WorkspaceBadge name={workspace.machine.name} state={workspace.state} computer={workspace.computer} /></>}
                        />
                        {(operation || repository.ahead > 0) && (
                          <div className="flex min-h-6 items-start pr-2 pb-2 pl-10" data-repository-actions>
                            {operation
                              ? <RepositoryPushFeedback operation={operation} workspace={workspaceTarget(workspace)} repositoryPath={repository.path} onRetry={push} onDismiss={onDismissRepositoryPush} />
                              : <Button variant="outline" size="xs" disabled={!canPush} aria-label={`Push ${commitLabel(repository.ahead)} for ${repository.path} in ${sandbox}`} onClick={() => { if (canPush) push() }}>Push {commitLabel(repository.ahead)}</Button>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </ListCard>
              ) : <EmptyState icon={<GitBranch />} title="No repositories checked out" className="min-h-24" />}
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

const activityCategoryOptions: ReadonlyArray<FilterOption<ApplicationActivityCategory>> = [
  { value: "sandbox", label: "Sandbox" },
  { value: "git", label: "Git" },
  { value: "backup", label: "Export & import" },
  { value: "secrets", label: "Secrets" },
  { value: "github", label: "GitHub" },
  { value: "system", label: "System" },
]

const activityCategoryPresentation = {
  sandbox: { label: "Sandbox", icon: Box },
  git: { label: "Git", icon: GitBranch },
  backup: { label: "Export & import", icon: Archive },
  secrets: { label: "Secrets", icon: KeyRound },
  github: { label: "GitHub", icon: Cloud },
  system: { label: "System", icon: Wrench },
} as const

function ActivityLog({ workspaces, sourceActivities, filtered, onShowLogs }: { workspaces: ApplicationWorkspace[]; sourceActivities: ApplicationActivity[]; filtered: boolean; onShowLogs: (activity: ApplicationActivity) => void }) {
  const [selectedCategories, setSelectedCategories] = useState<Set<ApplicationActivityCategory>>(() => new Set())
  const workspacesByTarget = new Map(workspaces.map((workspace) => [workspaceTarget(workspace), workspace]))
  // Only a sandbox filter hides entries; without one, a deleted sandbox's events stay visible.
  const allActivities = [...sourceActivities]
    .filter(({ workspace }) => !filtered || !workspace || workspacesByTarget.has(workspace))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  const activities = selectedCategories.size === 0
    ? allActivities
    : allActivities.filter(({ category }) => selectedCategories.has(category))

  if (workspaces.length === 0 && allActivities.length === 0) return <EmptyState icon={<Activity />} title="No recent activity" description="Sandbox and system activity will appear here." />

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
            const workspace = item.workspace ? workspacesByTarget.get(item.workspace) : undefined
            return (
              <ListRow
                key={item.id}
                role="listitem"
                aria-busy={item.status === "running" || undefined}
                data-activity-id={item.id}
                data-activity-status={item.status}
                className={cn(
                  "hover:bg-muted/35 select-text",
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
                    {/* A failure's detail can carry raw runtime output: keep it behind Details. */}
                    {item.tone === "danger" && item.detail
                      ? <ErrorDetails message={item.detail} />
                      : <p className="whitespace-pre-wrap break-words">{item.detail}</p>}
                    {workspace && item.tone === "danger" && <Button size="xs" variant="outline" onClick={() => onShowLogs(item)}>Show logs</Button>}
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
                      {item.workspace && (workspace
                        ? <WorkspaceBadge name={workspace.machine.name} state={workspace.state} computer={workspace.computer} />
                        : <StatusBadge indicator={<Box className="size-2.5" />} aria-label={`Sandbox: ${item.workspace}`}>{item.workspace}</StatusBadge>)}
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
  source,
  network, networkError, networkActions, onSectionChange,
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
  onCreateSandbox,
}: {
  /** The application source, for the same availability rules as the other surfaces. */
  source: ApplicationSource
  onSectionChange: (section: WorkspaceDetailSection) => void
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
  /** Opens the new-sandbox editor; omitted while a sandbox cannot be created. */
  onCreateSandbox?: () => void
}) {
  const [logWindow, setLogWindow] = useState<LogWindow>()
  useRepositoryPushToasts(repositoryPushOperations, {
    onPush: onPushRepository,
    onDismiss: onDismissRepositoryPush,
    resolveSandbox: (target) => {
      const machine = workspaces.find((workspace) => workspaceTarget(workspace) === target)?.machine
      return machine ? { id: machine.id, name: machine.name } : undefined
    },
  })
  const visibleWorkspaces = useMemo(
    () => selectedWorkspaceIds.size === 0 ? workspaces : workspaces.filter(({ machine }) => selectedWorkspaceIds.has(machine.id)),
    [workspaces, selectedWorkspaceIds],
  )
  // An empty filter means every sandbox, so an empty list means there are none yet: offer to
  // create one. Activity still shows system events and those of deleted sandboxes.
  const hasSandboxes = workspaces.length > 0
  if (!hasSandboxes && section !== "activity") {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 sm:py-6">
        <EmptyState
          icon={<Boxes />}
          title="No sandboxes yet"
          description="Create a sandbox to browse its files, logs and network ports here."
          action={onCreateSandbox && <Button variant="outline" size="xs" onClick={onCreateSandbox}><Plus aria-hidden="true" data-icon="inline-start" />New sandbox</Button>}
        />
      </div>
    )
  }

  return (
    <div className={cn("mx-auto grid h-full min-h-0 w-full max-w-4xl gap-4 overflow-hidden px-4 py-5 sm:px-6 sm:py-6", hasSandboxes ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]")}>
      {hasSandboxes && <WorkspaceFilterBar workspaces={workspaces} selectedWorkspaceIds={selectedWorkspaceIds} onChange={onWorkspaceFilterChange} />}
      {section === "files" && <Files source={source} onRefreshRepositories={networkActions.refreshRepositories} editor={editor} onOpenEditor={onOpenEditor} directoryStore={directoryStore} active={active} workspaces={visibleWorkspaces} repositoryPushOperations={repositoryPushOperations} onPushRepository={onPushRepository} onDismissRepositoryPush={onDismissRepositoryPush} />}
      {section === "logs" && <Logs key={JSON.stringify(visibleWorkspaces.map(workspaceTarget))} workspaces={visibleWorkspaces} query={logQuery} onQueryChange={onLogQueryChange} actions={networkActions} active={active} window={logWindow} onWindowChange={setLogWindow} />}
      {section === "network" && <NetworkPage workspaces={visibleWorkspaces} browser={browser} network={network} error={networkError} actions={networkActions} active={active} />}
      {section === "activity" && <ActivityLog workspaces={visibleWorkspaces} sourceActivities={activities} filtered={selectedWorkspaceIds.size > 0} onShowLogs={activity => {
        const workspace = workspaces.find(item => workspaceTarget(item) === activity.workspace)
        if (workspace) onWorkspaceFilterChange(new Set([workspace.machine.id]))
        const time = new Date(activity.occurredAt).getTime()
        setLogWindow({ since: new Date(time - 5 * 60000).toISOString(), until: new Date(time + 5 * 60000).toISOString() })
        onLogQueryChange("")
        onSectionChange("logs")
      }} />}
    </div>
  )
}

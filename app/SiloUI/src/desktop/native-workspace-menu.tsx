import { useRef, useState } from "react"
import { Menu, type MenuOptions } from "@tauri-apps/api/menu"
import { LogicalPosition } from "@tauri-apps/api/dpi"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { workspaceAvailability } from "@/features/application/model/workspace-availability"
import type { WorkspaceMenuProps } from "@/features/status-bar/status-bar"

// HTML portals cannot draw outside the status webview. Let the OS own the
// popup and its submenus, including screen-edge placement and keyboard tracking.
export function NativeWorkspaceMenu({ workspace, source, actions, onFolders, onConfirm }: WorkspaceMenuProps) {
  const opening = useRef(false)
  const [feedback, setFeedback] = useState("")
  const { machine } = workspace

  async function open(button: HTMLButtonElement) {
    if (opening.current) return
    opening.current = true
    setFeedback("")
    const bounds = button.getBoundingClientRect()
    const { canOpen, canStart, canStop, canRestart } = workspaceAvailability(workspace, source)
    const sites = workspace.ports.filter(({ listening }) => listening === true).sort((a, b) => a.port - b.port)
    const items: MenuOptions["items"] = [
      ...(workspace.state === "stopped"
        ? [{ text: "Start", enabled: canStart, action: () => actions.startWorkspace(machine.name) }]
        : [
          { text: "Stop…", enabled: canStop, action: () => onConfirm("stop") },
          { text: "Restart…", enabled: canRestart, action: () => onConfirm("restart") },
        ]),
      { item: "Separator" },
      { text: `Open in ${source.preferences.terminal}`, enabled: canOpen, action: () => actions.openTerminal(machine.name) },
      { text: `Open in ${source.preferences.editor}…`, enabled: canOpen, action: onFolders },
      {
        text: "Open site", enabled: canOpen && Boolean(workspace.host), items: [
          ...(sites.length
            ? sites.map(({ port }) => ({ text: `Port ${port}`, action: () => actions.openSite(machine.name, port) }))
            : [{ text: "No active sites", enabled: false }]),
          { item: "Separator" },
          { text: "Copy base URL", action: () => {
            void navigator.clipboard.writeText(`http://${workspace.host}`).then(
              () => setFeedback("Base URL copied"),
              () => setFeedback("Couldn't copy base URL"),
            )
          } },
        ],
      },
    ]
    let menu: Menu | undefined
    try {
      menu = await Menu.new({ items })
      await menu.popup(new LogicalPosition(bounds.left, bounds.bottom))
    } catch (error) {
      console.error("Silo status menu:", error)
      setFeedback("Couldn't open sandbox actions. Try again.")
    } finally {
      opening.current = false
      // On macOS popup resolves after native menu tracking ends.
      if (menu) void menu.close().catch(console.error)
    }
  }

  return <>
    <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${machine.name}`} aria-haspopup="menu"
      onClick={(event) => { void open(event.currentTarget) }}><MoreHorizontal /></Button>
    {feedback && <span role="status" className="text-xs text-muted-foreground">{feedback}</span>}
  </>
}

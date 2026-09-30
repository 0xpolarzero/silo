import { useRef } from "react"
import { Menu, type MenuOptions } from "@tauri-apps/api/menu"
import { LogicalPosition } from "@tauri-apps/api/dpi"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { showActionFailure, showQuickConfirmation } from "@/lib/operation-toast"
import { workspaceTarget } from "@/features/application/model/remote-computers"
import type { WorkspaceMenuProps } from "@/features/status-bar/status-bar-types"
import { workspaceMenuItems, type WorkspaceMenuItem } from "@/features/status-bar/workspace-menu-items"

type NativeItems = NonNullable<MenuOptions["items"]>

// The same items as the browser preview's Radix menu, as native menu entries.
function nativeItems(items: WorkspaceMenuItem[]): NativeItems {
  return items.map((item): NativeItems[number] => {
    if (item.kind === "separator") return { item: "Separator" }
    if (item.kind === "submenu") return { text: item.label, enabled: item.enabled, items: nativeItems(item.items) }
    if (item.kind === "copy") {
      return { text: item.label, action: () => {
        void navigator.clipboard.writeText(item.value).then(
          () => showQuickConfirmation(item.copied),
          (error) => showActionFailure(item.failed, error, undefined, { native: false }),
        )
      } }
    }
    return { text: item.label, enabled: item.enabled, action: item.run }
  })
}

// HTML portals cannot draw outside the status webview. Let the OS own the
// popup and its submenus, including screen-edge placement and keyboard tracking.
export function NativeWorkspaceMenu({ workspace, source, actions, onFolders, onConfirm }: WorkspaceMenuProps) {
  const opening = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { machine } = workspace
  const target = workspaceTarget(workspace)

  async function open(button: HTMLButtonElement) {
    if (opening.current) return
    opening.current = true
    const bounds = button.getBoundingClientRect()
    const items = nativeItems(workspaceMenuItems(workspace, source, {
      start: () => actions.startWorkspace(target),
      confirm: onConfirm,
      openTerminal: () => actions.openTerminal(target),
      chooseFolder: onFolders,
      openSite: (port) => actions.openSite(target, port),
    }))
    let menu: Menu | undefined
    try {
      menu = await Menu.new({ items })
      await menu.popup(new LogicalPosition(bounds.left, bounds.bottom))
    } catch (error) {
      console.error("Silo status menu:", error)
      showActionFailure("Couldn't open sandbox actions", error, () => { if (buttonRef.current) void open(buttonRef.current) }, { native: false })
    } finally {
      opening.current = false
      // On macOS popup resolves after native menu tracking ends.
      if (menu) void menu.close().catch(console.error)
    }
  }

  return <>
    <Button ref={buttonRef} variant="ghost" size="icon-xs" aria-label={`Actions for ${machine.name}`} aria-haspopup="menu"
      onClick={(event) => { void open(event.currentTarget) }}><MoreHorizontal /></Button>
  </>
}

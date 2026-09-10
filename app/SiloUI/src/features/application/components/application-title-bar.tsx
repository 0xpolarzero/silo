import type { ReactNode, RefObject } from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { shortcutFor } from "@/lib/shortcuts"
import { ToolbarButton, WindowToolbar } from "@/components/window-toolbar"

export function ApplicationTitleBar({
  collapsed,
  previewing,
  toggleRef,
  onToggleSidebar,
  onPreviewEnter,
  onPreviewLeave,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  commandMenu,
  disabled = false,
}: {
  collapsed: boolean
  previewing: boolean
  toggleRef: RefObject<HTMLButtonElement | null>
  onToggleSidebar: () => void
  onPreviewEnter: () => void
  onPreviewLeave: () => void
  canGoBack: boolean
  canGoForward: boolean
  onGoBack: () => void
  onGoForward: () => void
  commandMenu?: ReactNode
  disabled?: boolean
}) {
  return (
    <WindowToolbar
      title="Silo"
      sidebarDisabled={disabled}
      sidebarShortcut={shortcutFor("toggle-sidebar")}
      sidebarId="application-sidebar"
      collapsed={collapsed}
      previewing={previewing}
      toggleRef={toggleRef}
      onToggleSidebar={onToggleSidebar}
      onPreviewEnter={onPreviewEnter}
      onPreviewLeave={onPreviewLeave}
      navigation={<>
        <ToolbarButton shortcut={shortcutFor("go-back")} label="Go back" disabled={disabled || !canGoBack} onClick={onGoBack}><ArrowLeft /></ToolbarButton>
        <ToolbarButton shortcut={shortcutFor("go-forward")} label="Go forward" disabled={disabled || !canGoForward} onClick={onGoForward}><ArrowRight /></ToolbarButton>
      </>}
    >
      {commandMenu}
    </WindowToolbar>
  )
}

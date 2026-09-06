import type { ReactNode, RefObject } from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"

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
}) {
  return (
    <WindowToolbar
      title="Silo"
      sidebarId="application-sidebar"
      collapsed={collapsed}
      previewing={previewing}
      toggleRef={toggleRef}
      onToggleSidebar={onToggleSidebar}
      onPreviewEnter={onPreviewEnter}
      onPreviewLeave={onPreviewLeave}
      navigation={<>
        <ToolbarButton label="Go back" disabled={!canGoBack} onClick={onGoBack}><ArrowLeft /></ToolbarButton>
        <ToolbarButton label="Go forward" disabled={!canGoForward} onClick={onGoForward}><ArrowRight /></ToolbarButton>
      </>}
    >
      {commandMenu}
    </WindowToolbar>
  )
}

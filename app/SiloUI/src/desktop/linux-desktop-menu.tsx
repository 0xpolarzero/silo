import { useEffect, useRef } from "react"
import { Menu } from "@tauri-apps/api/menu"
import { LogicalPosition } from "@tauri-apps/api/dpi"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Ellipsis } from "lucide-react"
import { ActionsMenu } from "@/components/actions-menu"
import { Button } from "@/components/ui/button"

export type DesktopMenuProps = {
  busy: boolean
  onSelect: (action: "stop" | "restart") => void
  onError: (message: string) => void
}

export function DesktopActionsMenu({ busy, onSelect }: DesktopMenuProps) {
  return <ActionsMenu label="Desktop actions" items={[
    { label: "Restart desktop", disabled: busy, onSelect: () => onSelect("restart") },
    { label: "Stop desktop", disabled: busy, onSelect: () => onSelect("stop") },
  ]} />
}

// The guest is a separate native webview above the shell. HTML dropdowns cannot
// cover it; use an OS popup without resizing or disconnecting the desktop.
export function NativeDesktopActionsMenu({ busy, onSelect, onError }: DesktopMenuProps) {
  const opening = useRef(false)
  const menu = useRef<Menu | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void menu.current?.close().catch(() => {})
      menu.current = null
    }
  }, [])

  async function open(button: HTMLButtonElement) {
    if (opening.current || busy) return
    opening.current = true
    const bounds = button.getBoundingClientRect()
    try {
      await menu.current?.close()
      menu.current = null
      const next = await Menu.new({ items: [
        { text: "Restart desktop…", action: () => { if (mounted.current) onSelect("restart") } },
        { text: "Stop desktop…", action: () => { if (mounted.current) onSelect("stop") } },
      ] })
      if (!mounted.current) { await next.close(); return }
      menu.current = next
      const currentWindow = getCurrentWindow()
      const [size, scale] = await Promise.all([currentWindow.innerSize(), currentWindow.scaleFactor()])
      // WKWebView's CSS viewport can begin below the native content origin.
      const inset = Math.max(0, size.height / scale - window.innerHeight)
      if (mounted.current) await next.popup(new LogicalPosition(bounds.left, bounds.bottom + inset))
      // GTK popup returns before dismissal. Keep the resource alive until the
      // next opening or unmount, rather than destroying a menu still in use.
    } catch {
      if (mounted.current) onError("Couldn't open desktop actions. Try again.")
    } finally {
      opening.current = false
    }
  }

  return <Button variant="ghost" size="icon-xs" aria-label="Desktop actions" aria-haspopup="menu" disabled={busy}
    onClick={event => { void open(event.currentTarget) }}><Ellipsis /></Button>
}

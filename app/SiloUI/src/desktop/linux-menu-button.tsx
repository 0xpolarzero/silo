import { useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"

export function LinuxMenuButton({ disabled = false }: { disabled?: boolean }) {
  const [error, setError] = useState(false)
  if (!isTauri() || !navigator.platform.startsWith("Linux")) return null
  return <div className="relative mx-3 shrink-0">
    <Button variant="ghost" size="sm" disabled={disabled} aria-keyshortcuts="Alt F10" onClick={() => {
      setError(false)
      void invoke("show_app_menu").catch(() => setError(true))
    }}><Menu aria-hidden="true" className="size-3.5" />Menu</Button>
    {error && <p role="alert" className="absolute top-full right-0 z-50 w-56 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md">Could not open the menu. Try again.</p>}
  </div>
}

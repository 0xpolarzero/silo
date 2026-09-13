import { useRef, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { UpdateNotice, UpdatesCard } from "@/features/updates/updates"

export function OnboardingUpdates() {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverAnchor asChild>
      <div className="pointer-events-none absolute inset-x-0 top-3 z-20 mx-auto flex w-full max-w-4xl justify-center px-4 sm:px-6">
        <UpdateNotice onOpen={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          setOpen(true)
        }} />
      </div>
    </PopoverAnchor>
    <PopoverContent aria-label="Silo updates" align="center" className="w-[min(32rem,calc(100vw-2rem))] max-h-[70dvh] overflow-y-auto p-3" onCloseAutoFocus={(event) => {
      event.preventDefault()
      opener.current?.focus()
    }}>
      <div className="mb-2 flex justify-end">
        <Button size="icon-xs" variant="ghost" aria-label="Close updates" onClick={() => setOpen(false)}><X className="size-3" /></Button>
      </div>
      <UpdatesCard />
    </PopoverContent>
  </Popover>
}

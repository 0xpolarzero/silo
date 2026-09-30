import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react"
import { DropdownMenu } from "radix-ui"
import { Ellipsis, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useReduceMotion } from "@/components/ui/reduce-motion"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface MenuAction {
  label: string
  separatorBefore?: boolean
  icon?: LucideIcon
  accessibleLabel?: string
  disabled?: boolean
  description?: string
  tooltip?: string
  destructive?: boolean
  keepOpen?: boolean
  /** The selection opens a popover anchored to the ⋯ button: the menu must not steal focus back as it closes. */
  opensPopover?: boolean
  /**
   * Opens the popover registered under this key in `ActionsMenu`'s `popovers`, anchored to the
   * ⋯ button. Implies `opensPopover`; `onSelect` is optional and runs first.
   */
  popover?: string
  onSelect?: () => void
}

/** Renders a popover body for a menu item's `popover` key. Call `close` to dismiss it. */
export type MenuPopovers = Record<string, (close: () => void) => ReactNode>

/**
 * The ⋯ button and its menu. Items with a `popover` key open that popover, anchored to the ⋯
 * button, from one shared host owned by this menu: the popover state lives with the menu, so
 * Escape, Cancel, an outside click and unmounting (leaving the page) all close it, and several
 * popovers never nest around the same button.
 */
export function ActionsMenu({ label, items, onClose, disabled = false, ref, popovers, openPanel }: {
  label: string
  items: MenuAction[]
  onClose?: () => void
  disabled?: boolean
  ref?: Ref<HTMLButtonElement>
  popovers?: MenuPopovers
  /** Opens a popover without the menu (a command palette request); each token opens it once. */
  openPanel?: { token: number; panel: string }
}) {
  const descriptionId = useId()
  const opensPopover = useRef(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [panel, setPanel] = useState<string | null>(null)
  const openedPanel = useRef(0)
  useEffect(() => {
    if (!openPanel || openedPanel.current === openPanel.token) return
    openedPanel.current = openPanel.token
    // oxlint-disable-next-line react/set-state-in-effect
    setPanel(openPanel.panel)
  }, [openPanel])
  const reduceMotion = useReduceMotion()
  const close = () => setPanel(null)
  const render = panel ? popovers?.[panel] : undefined
  return <Popover open={Boolean(render)} onOpenChange={open => { if (!open) close() }}>
    <DropdownMenu.Root onOpenChange={open => { if (!open) onClose?.() }}>
    <Tooltip><TooltipTrigger asChild><DropdownMenu.Trigger asChild><PopoverAnchor asChild><Button ref={node => { trigger.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node }} variant="ghost" size="icon-xs" aria-label={label} disabled={disabled}><Ellipsis /></Button></PopoverAnchor></DropdownMenu.Trigger></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} onCloseAutoFocus={event => { if (opensPopover.current) { event.preventDefault(); opensPopover.current = false } }} data-reduce-motion={reduceMotion || undefined} className="silo-portal z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map((item, index) => {
        const itemDisabled = disabled || item.disabled
        const entry = <DropdownMenu.Item aria-label={item.accessibleLabel ?? item.label} aria-describedby={item.description ? `${descriptionId}-${index}` : undefined} disabled={itemDisabled} onSelect={event => { if (item.keepOpen) event.preventDefault(); opensPopover.current = Boolean(item.opensPopover || item.popover); item.onSelect?.(); if (item.popover) setPanel(item.popover) }} className={`flex items-center gap-2 cursor-default rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${item.destructive ? "text-destructive" : ""}`}>{item.icon && <item.icon aria-hidden="true" className="size-3.5 shrink-0" />}<span className="grid gap-0.5"><span>{item.label}</span>{item.description && <span id={`${descriptionId}-${index}`} className="max-w-64 whitespace-normal text-[11px] font-normal text-muted-foreground">{item.description}</span>}</span></DropdownMenu.Item>
        return <Fragment key={item.accessibleLabel ?? item.label}>
          {item.separatorBefore && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          {item.tooltip ? <Tooltip><TooltipTrigger asChild><span className="block" tabIndex={itemDisabled ? 0 : undefined} aria-label={itemDisabled ? item.tooltip : undefined}>{entry}</span></TooltipTrigger><TooltipContent>{item.tooltip}</TooltipContent></Tooltip> : entry}
        </Fragment>
      })}
    </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <PopoverContent align="end" className="w-64 p-3 text-xs" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}>
      {render?.(close)}
    </PopoverContent>
  </Popover>
}

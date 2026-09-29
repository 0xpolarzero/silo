import { Fragment, useRef, type Ref } from "react"
import { DropdownMenu } from "radix-ui"
import { Ellipsis, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface MenuAction {
  label: string
  separatorBefore?: boolean
  icon?: LucideIcon
  accessibleLabel?: string
  disabled?: boolean
  tooltip?: string
  destructive?: boolean
  keepOpen?: boolean
  /** The selection opens a popover anchored to the ⋯ button: the menu must not steal focus back as it closes. */
  opensPopover?: boolean
  onSelect: () => void
}

/**
 * The ⋯ button and its menu. `ref` points at the button, so a popover can anchor to it:
 * `<ConfirmPopover anchor={<ActionsMenu … />} … />` (see components/confirm-popover.tsx).
 */
export function ActionsMenu({ label, items, onClose, disabled = false, ref }: { label: string; items: MenuAction[]; onClose?: () => void; disabled?: boolean; ref?: Ref<HTMLButtonElement> }) {
  const opensPopover = useRef(false)
  return <DropdownMenu.Root onOpenChange={open => { if (!open) onClose?.() }}>
    <Tooltip><TooltipTrigger asChild><DropdownMenu.Trigger asChild><Button ref={ref} variant="ghost" size="icon-xs" aria-label={label} disabled={disabled}><Ellipsis /></Button></DropdownMenu.Trigger></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} onCloseAutoFocus={event => { if (opensPopover.current) { event.preventDefault(); opensPopover.current = false } }} className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map(item => {
        const itemDisabled = disabled || item.disabled
        const entry = <DropdownMenu.Item aria-label={item.accessibleLabel} disabled={itemDisabled} onSelect={event => { if (item.keepOpen) event.preventDefault(); opensPopover.current = Boolean(item.opensPopover); item.onSelect() }} className={`flex items-center gap-2 cursor-default rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${item.destructive ? "text-destructive" : ""}`}>{item.icon && <item.icon aria-hidden="true" className="size-3.5 shrink-0" />}{item.label}</DropdownMenu.Item>
        return <Fragment key={item.accessibleLabel ?? item.label}>
          {item.separatorBefore && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          {item.tooltip ? <Tooltip><TooltipTrigger asChild><span className="block" tabIndex={itemDisabled ? 0 : undefined} aria-label={itemDisabled ? item.tooltip : undefined}>{entry}</span></TooltipTrigger><TooltipContent>{item.tooltip}</TooltipContent></Tooltip> : entry}
        </Fragment>
      })}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

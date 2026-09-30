"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { useReduceMotion } from "@/components/ui/reduce-motion"
import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverAnchor = PopoverPrimitive.Anchor
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Portalled to <body>, outside .silo-window: carry the reduced-motion preference along.
  const reduceMotion = useReduceMotion()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-reduce-motion={reduceMotion || undefined}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "silo-portal z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }

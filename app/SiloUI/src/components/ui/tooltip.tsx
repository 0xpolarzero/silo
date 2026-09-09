"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { isRestoringFocus } from "@/lib/focus"
import { cn } from "@/lib/utils"

const Tooltip = TooltipPrimitive.Root
const ReduceMotionContext = React.createContext(false)

function TooltipProvider({ reduceMotion, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider> & { reduceMotion?: boolean }) {
  const inheritedReduceMotion = React.useContext(ReduceMotionContext)
  return <ReduceMotionContext value={reduceMotion ?? inheritedReduceMotion}>
    <TooltipPrimitive.Provider {...props} />
  </ReduceMotionContext>
}

function TooltipTrigger({ onFocus, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger {...props} onFocus={(event) => {
    onFocus?.(event)
    // Keep the restored keyboard position without opening a tooltip on dismissal.
    if (isRestoringFocus(event.currentTarget)) event.preventDefault()
  }} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const reduceMotion = React.useContext(ReduceMotionContext)
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-56 select-text selection:bg-primary-foreground/25 selection:text-primary-foreground rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 motion-reduce:animate-none!",
          className,
        )}
        style={reduceMotion ? { ...style, animation: "none" } : style}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-primary" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }

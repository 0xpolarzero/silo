import type { ReactNode } from "react"
import { isTauri } from "@tauri-apps/api/core"

import { WindowTitleBar } from "@/components/window-toolbar"
import { cn } from "@/lib/utils"
import "./sidebar-shell.css"

interface SiloWindowProps {
  title: string
  label: string
  children: ReactNode
  className?: string
  titleBar?: ReactNode
  reduceMotion?: boolean
}

export function SiloWindow({ title, label, children, className, titleBar, reduceMotion }: SiloWindowProps) {
  const desktop = isTauri()
  return (
    <main className={desktop ? "h-dvh" : "grid min-h-dvh place-items-center bg-muted/50 p-0 sm:p-4"}>
      <section
        className={cn(
          "silo-window flex h-dvh w-full flex-col overflow-hidden border-border bg-background",
          !desktop && "max-w-[68rem] shadow-2xl sm:h-[min(46rem,calc(100dvh-2rem))] sm:rounded-xl sm:border",
          className,
        )}
        aria-label={label}
        data-reduce-motion={reduceMotion || undefined}
      >
        {titleBar ?? <WindowTitleBar title={title} />}
        {children}
      </section>
    </main>
  )
}

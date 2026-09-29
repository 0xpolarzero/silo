import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * `technical` marks a field holding an identifier or technical value (names, domains, ports,
 * emails, paths, filters). It turns off macOS/iOS auto-capitalization, autocorrect, spellcheck
 * and browser autofill, which would otherwise rewrite e.g. "e2e-test" to "E2e-test". Prose
 * fields simply omit it. Explicit attributes still win.
 */
function Input({ className, type, technical = false, ...props }: React.ComponentProps<"input"> & { technical?: boolean }) {
  const technicalProps = technical ? { autoCapitalize: "off", autoCorrect: "off", spellCheck: false, autoComplete: "off" } as const : undefined
  return (
    <input
      type={type}
      {...technicalProps}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }

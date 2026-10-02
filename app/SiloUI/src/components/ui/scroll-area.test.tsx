import { render } from "@testing-library/react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"
import { compile } from "tailwindcss"
import { expect, it } from "vitest"

import { ScrollBar } from "./scroll-area"

it.each(["vertical", "horizontal"] as const)("gives the %s scrollbar a usable thickness", async (orientation) => {
  const { container } = render(<ScrollAreaPrimitive.Root type="always">
    <ScrollAreaPrimitive.Viewport>Sandbox content</ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation={orientation} />
  </ScrollAreaPrimitive.Root>)
  const scrollbar = container.querySelector<HTMLElement>("[data-slot=scroll-area-scrollbar]")!
  const compiler = await compile("@theme inline { --spacing: .25rem; } @tailwind utilities;")
  const style = document.createElement("style")
  style.textContent = compiler.build(scrollbar.className.split(" "))
  document.head.append(style)
  try {
    const painted = getComputedStyle(scrollbar)
    expect(orientation === "vertical" ? painted.width : painted.height).toBe("calc(0.625rem)")
    if (orientation === "horizontal") expect(painted.flexDirection).toBe("column")
  } finally {
    style.remove()
  }
})

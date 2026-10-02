import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { compile } from "tailwindcss"
import { expect, it } from "vitest"

import { Checkbox } from "./checkbox"

it.each(["light", "dark"])("paints the checked background and contrasting indicator in %s mode", async (theme) => {
  const user = userEvent.setup()
  render(<div className={theme === "dark" ? "dark" : undefined}><Checkbox aria-label="Apply Git identity" /></div>)
  const checkbox = screen.getByRole("checkbox", { name: "Apply Git identity" })
  const compiler = await compile("@custom-variant dark (&:is(.dark *)); @theme { --color-primary: red; --color-primary-foreground: white; } @tailwind utilities;")
  const style = document.createElement("style")
  style.textContent = compiler.build(checkbox.className.split(" "))
  document.head.append(style)
  try {
    expect(checkbox).not.toBeChecked()
    expect(getComputedStyle(checkbox).backgroundColor).not.toBe("var(--color-primary)")
    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(getComputedStyle(checkbox).backgroundColor).toBe("var(--color-primary)")
    expect(getComputedStyle(checkbox).color).toBe("var(--color-primary-foreground)")
    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(getComputedStyle(checkbox).backgroundColor).not.toBe("var(--color-primary)")
  } finally {
    style.remove()
  }
})

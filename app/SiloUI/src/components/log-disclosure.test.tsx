import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { LogDisclosure } from "./log-disclosure"

describe("LogDisclosure keyboard access", () => {
  it.each([undefined, "Setup output"])("makes output reachable by Tab with label %s", async (outputLabel) => {
    const user = userEvent.setup()
    render(<LogDisclosure title="Technical details" output={Array.from({ length: 40 }, (_, index) => `Line ${index}`).join("\n")} outputLabel={outputLabel} />)
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show technical details" }))
    await user.tab()
    expect(screen.getByRole("button", { name: "Copy technical details" })).toHaveFocus()
    await user.tab()
    expect(screen.getByText(/Line 39/)).toHaveFocus()
    expect(screen.getByRole("region", { name: outputLabel ?? "Technical details" })).toHaveFocus()
  })
})

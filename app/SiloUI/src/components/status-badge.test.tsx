import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { StatusBadge } from "./status-badge"

describe("status badge text", () => {
  it("reveals the complete label when it is truncated", () => {
    const name = "long-computer-name".repeat(15)
    render(<StatusBadge indicator={<span />}>{name}</StatusBadge>)
    expect(screen.getByText(name)).toHaveAttribute("title", name)
  })
})

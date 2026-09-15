import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Terminal } from "lucide-react"
import { describe, expect, it, vi } from "vitest"
import { CopyButton } from "./copy-button"

const labels = { idle: "Copy command", copied: "Command copied", failed: "Copy failed" }
describe("CopyButton icons and feedback", () => {
  it.each([undefined, Terminal])("copies and reports success with either idle icon", async icon => {
    const user = userEvent.setup()
    render(<CopyButton icon={icon} value="ssh -p 2222 root@127.0.0.1" labels={labels} />)
    await user.click(screen.getByRole("button", { name: "Copy command" }))
    expect(await navigator.clipboard.readText()).toBe("ssh -p 2222 root@127.0.0.1")
    expect(screen.getByRole("button", { name: "Command copied" })).toHaveAttribute("data-copy-status", "copied")
  })
  it("reports clipboard failure with the terminal icon", async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Clipboard unavailable"))
    render(<CopyButton icon={Terminal} value="ssh root@127.0.0.1" labels={labels} />)
    await user.click(screen.getByRole("button", { name: "Copy command" }))
    expect(screen.getByRole("button", { name: "Copy failed" })).toHaveAttribute("data-copy-status", "failed")
  })
})

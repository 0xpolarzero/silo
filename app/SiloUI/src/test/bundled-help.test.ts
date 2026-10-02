import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("directs connected-sandbox checkpoint deletion to the owning computer", () => {
  const help = new DOMParser().parseFromString(readFileSync("docs/silo-help.html", "utf8"), "text/html")
  const instructions = [...help.querySelectorAll("p")].find(paragraph => paragraph.textContent?.includes("Delete checkpoint data"))
  expect(instructions?.textContent).toMatch(/on the (?:sandbox's )?owning computer/i)
})

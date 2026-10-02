import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("directs connected-sandbox checkpoint deletion to the owning computer", () => {
  const help = new DOMParser().parseFromString(readFileSync("docs/silo-help.html", "utf8"), "text/html")
  const instructions = [...help.querySelectorAll("p")].find(paragraph => paragraph.textContent?.includes("Delete checkpoint data"))
  expect(instructions?.textContent).toMatch(/on the (?:sandbox's )?owning computer/i)
})

it("qualifies Safari sandbox hostname support for older supported macOS versions", () => {
  const help = new DOMParser().parseFromString(readFileSync("docs/silo-help.html", "utf8"), "text/html")
  const instructions = [...help.querySelectorAll("p")].find(paragraph => paragraph.querySelector("strong")?.textContent === "Network")
  expect(instructions?.textContent).toMatch(/Safari.*macOS 26/)
  expect(instructions?.textContent).toMatch(/Chrome or Firefox/)
  expect(instructions?.textContent).not.toMatch(/every browser/i)
  expect(instructions?.textContent).toMatch(/127\.0\.0\.1.*shares.*cookie/i)
})

it("qualifies copying diagnostics because some Details sections have no copy control", () => {
  const help = new DOMParser().parseFromString(readFileSync("docs/silo-help.html", "utf8"), "text/html")
  const instructions = [...help.querySelectorAll("p")].find(paragraph => paragraph.textContent?.includes("Read the operation's error"))
  expect(instructions?.textContent).toMatch(/copy control when.*offered/i)
})

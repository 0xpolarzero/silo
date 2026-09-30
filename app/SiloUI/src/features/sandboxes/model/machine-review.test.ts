import { describe, expect, it } from "vitest"

import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { rebaseMachineDraft } from "./machine-review"

const opened = productionMachineDefaults[0]!

describe("rebasing a draft after a stale save", () => {
  it("keeps the user's edits, adopts other changes and lists fields changed on both sides", () => {
    const latest = { ...opened, cpus: 6, maxMemoryGiB: 64, desktop: { startWithSandbox: true } }
    const draft = { ...opened, cpus: 4, memoryGiB: 16 }
    const { draft: rebased, review } = rebaseMachineDraft(opened, latest, draft)
    expect(rebased).toEqual({ ...opened, cpus: 4, memoryGiB: 16, maxMemoryGiB: 64, desktop: { startWithSandbox: true } })
    expect(review.conflicts).toEqual([{ field: "cpus", label: "CPUs limit", theirs: "6 CPUs", mine: "4 CPUs" }])
    expect(review.adopted).toEqual(["Memory ceiling", "Linux desktop"])
  })

  it("does not list a field both sides changed to the same value", () => {
    const { draft, review } = rebaseMachineDraft(opened, { ...opened, cpus: 4 }, { ...opened, cpus: 4 })
    expect(draft).toEqual({ ...opened, cpus: 4 })
    expect(review).toEqual({ conflicts: [], adopted: [] })
  })

  it("keeps a removal made elsewhere unless the user changed that field", () => {
    const withDesktop = { ...opened, desktop: { startWithSandbox: true } }
    const { draft } = rebaseMachineDraft(withDesktop, opened, { ...withDesktop, cpus: 2 })
    expect(draft).toEqual({ ...opened, cpus: 2 })
    expect(draft).not.toHaveProperty("desktop")
  })
})

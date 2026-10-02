import { describe, expect, it } from "vitest"

import { productionMachineDefaults } from "@/features/onboarding/model/machine-configuration"
import { rebaseMachineDraft } from "./machine-review"

const opened = productionMachineDefaults[0]!

describe("rebasing a draft after a stale save", () => {
  it.each(["__proto__", "constructor", "toString"])("retains unknown field %s and gives it a text label", field => {
    const latest = { ...opened, [field]: "new value" }
    const { draft, review } = rebaseMachineDraft(opened, latest, opened)
    expect(Object.hasOwn(draft, field)).toBe(true)
    expect(Reflect.get(draft, field)).toBe("new value")
    expect(review.adopted).toEqual([field])
  })

  it.each(["__proto__", "constructor", "toString"])("reviews a conflict in unknown field %s without losing its value", field => {
    const baseline = { ...opened, [field]: "original value" }
    const latest = { ...baseline, [field]: "elsewhere" }
    const mine = { ...baseline, [field]: "my value" }
    const { draft, review } = rebaseMachineDraft(baseline, latest, mine)
    expect(Object.hasOwn(draft, field)).toBe(true)
    expect(Reflect.get(draft, field)).toBe("my value")
    expect(review.conflicts).toEqual([{ field, label: field, theirs: "elsewhere", mine: "my value" }])
  })

  it.each(["__proto__", "constructor", "toString"])("adopts removal of unknown field %s without reading an inherited value", field => {
    const baseline = { ...opened, [field]: "original value" }
    const { draft, review } = rebaseMachineDraft(baseline, opened, { ...baseline, cpus: 2 })
    expect(Object.hasOwn(draft, field)).toBe(false)
    expect(draft).toEqual({ ...opened, cpus: 2 })
    expect(review).toEqual({ conflicts: [], adopted: [field] })
  })

  it.each(["constructor", "toString"])("keeps the user's removal of null-valued field %s during a concurrent edit", field => {
    const baseline = { ...opened, [field]: null }
    const latest = { ...baseline, [field]: "elsewhere" }
    const { draft, review } = rebaseMachineDraft(baseline, latest, opened)
    expect(Object.hasOwn(draft, field)).toBe(false)
    expect(review.conflicts).toEqual([{ field, label: field, theirs: "elsewhere", mine: "undefined" }])
  })

  it("keeps the user's edits, adopts other changes and lists fields changed on both sides", () => {
    const latest = { ...opened, cpus: 6, maxMemoryGiB: 64, desktop: { startWithSandbox: true } }
    const draft = { ...opened, cpus: 4, memoryGiB: 16 }
    const { draft: rebased, review } = rebaseMachineDraft(opened, latest, draft)
    expect(rebased).toEqual({ ...opened, cpus: 4, memoryGiB: 16, maxMemoryGiB: 64, desktop: { startWithSandbox: true } })
    expect(review.conflicts).toEqual([{ field: "cpus", label: "CPUs", theirs: "6 CPUs", mine: "4 CPUs" }])
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

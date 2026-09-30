import { act, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import { describe, expect, it } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { SettingsProvider } from "@/features/preferences/settings-store"
import { purgeDetachedStyleSheets } from "./stylesheets"

const sonnerSheet = () => [...document.styleSheets].find((sheet) => sheet.ownerNode?.textContent?.includes("[data-sonner-toaster]"))
const detachedSheets = () => [...document.styleSheets].filter((sheet) => !sheet.ownerNode?.isConnected)

describe("Sonner stylesheet gate", () => {
  it("applies Sonner's real CSS exactly while a toast is shown", async () => {
    render(<SettingsProvider initialSettings={{ theme: "light" }}><Toaster /></SettingsProvider>)
    getComputedStyle(document.body)
    expect(sonnerSheet()).toBeUndefined()

    act(() => { toast("Saved") })
    const item = (await screen.findByText("Saved")).closest("[data-sonner-toast]")!
    expect(getComputedStyle(item).position).toBe("absolute")
    expect(document.styleSheets[0]).toBe(sonnerSheet())
  })

  it("drops Sonner's CSS again once no toast list remains", () => {
    getComputedStyle(document.body)
    expect(sonnerSheet()).toBeUndefined()
  })
})

describe("detached stylesheet purge", () => {
  it("removes the sheet jsdom keeps for a style removed with its subtree", () => {
    const wrapper = document.createElement("div")
    wrapper.innerHTML = "<style>.leak { color: red }</style>"
    document.body.append(wrapper)
    wrapper.remove()
    expect(detachedSheets(), "jsdom no longer leaks this sheet; remove purgeDetachedStyleSheets").toHaveLength(1)

    purgeDetachedStyleSheets(document)
    expect(detachedSheets()).toEqual([])
  })

  it("leaves a leaked sheet for the next test", () => {
    const wrapper = document.createElement("div")
    wrapper.innerHTML = "<style>.leak { color: blue }</style>"
    document.body.append(wrapper)
    wrapper.remove()
    expect(detachedSheets()).toHaveLength(1)
  })

  it("purges leaked sheets before every test", () => {
    expect(detachedSheets()).toEqual([])
  })
})

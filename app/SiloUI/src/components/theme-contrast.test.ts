import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

import styles from "@/index.css?raw"
import { OperationToastBody } from "@/components/operation-toast-body"

// Muted text sits on every neutral surface, including muted chips (kind badges) and
// 11 px captions, so it must meet WCAG AA for normal text (4.5:1) on each of them.
const surfaces = ["--background", "--card", "--popover", "--muted", "--accent", "--secondary", "--sidebar", "--sidebar-accent"]

function tokens(selector: ":root" | ".dark") {
  const start = styles.indexOf(`${selector} {`)
  const block = styles.slice(start, styles.indexOf("}", start))
  return new Map([...block.matchAll(/(--[\w-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)].map(([, name, lightness, chroma]) => [name, { lightness: Number(lightness), chroma: Number(chroma) }]))
}

// For an achromatic OKLab colour the linear sRGB channels all equal L³, which is also its
// relative luminance.
function luminance(token: { lightness: number; chroma: number }) {
  expect(token.chroma).toBe(0)
  return token.lightness ** 3
}

function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function srgb(linear: number) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055
}

function linear(srgb: number) {
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

describe("muted text contrast", () => {
  it.each([":root", ".dark"] as const)("meets WCAG AA on every neutral surface in %s", (selector) => {
    const theme = tokens(selector)
    const text = luminance(theme.get("--muted-foreground")!)
    for (const surface of surfaces) {
      const ratio = contrast(text, luminance(theme.get(surface)!))
      expect(ratio, `${selector} --muted-foreground on ${surface}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe("pending operation steps", () => {
  it.each([":root", ".dark"] as const)("keeps pending text readable on the toast surface in %s", (selector) => {
    const { container } = render(createElement(OperationToastBody, { steps: [{ label: "Boot sandbox", state: "pending" }] }))
    const row = container.querySelector("li[data-state=pending]")!
    const color = row.className.match(/\btext-muted-foreground(?:\/(\d+))?\b/)
    expect(color).not.toBeNull()
    const opacity = color?.[1] ? Number(color[1]) / 100 : 1
    const theme = tokens(selector)
    const background = luminance(theme.get("--popover")!)
    const foreground = luminance(theme.get("--muted-foreground")!)
    const paintedText = linear(srgb(foreground) * opacity + srgb(background) * (1 - opacity))
    expect(contrast(paintedText, background)).toBeGreaterThanOrEqual(4.5)
  })
})

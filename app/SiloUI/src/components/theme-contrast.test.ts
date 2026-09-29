import { describe, expect, it } from "vitest"

import styles from "@/index.css?raw"

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

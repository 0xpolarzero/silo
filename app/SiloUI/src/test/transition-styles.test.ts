import { expect, it } from "vitest"
import { build } from "vite"

it("shipped transitions never delay hiding a screen or its descendants", async () => {
  // jsdom does not run CSS animations. Check the actual compiled stylesheet,
  // including shared components, variants, and custom CSS, instead of JSX classes.
  const result = await build({
    logLevel: "silent",
    build: { write: false, cssMinify: false },
  })
  if (!("output" in result)) throw new Error("Expected a single application build")
  const css = result.output.flatMap((file) => (
    file.type === "asset" && file.fileName.endsWith(".css") ? [String(file.source)] : []
  )).join("\n")
  const transitions = [...css.matchAll(/(?:^|[;{])\s*transition(?:-property)?\s*:\s*([^;}]+)/g)]
  expect(transitions.length).toBeGreaterThan(0)
  for (const [, properties] of transitions) {
    expect(properties, `Unsafe CSS transition: ${properties}`).not.toMatch(/(?:^|[\s,])(?:all|visibility)(?=$|[\s,])/)
  }
}, 15_000)

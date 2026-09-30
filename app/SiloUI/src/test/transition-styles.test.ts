import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { build } from "vite"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const sourceRoot = join(appRoot, "src")

// Stylesheets reach the bundle only through imports in application modules
// (CSS `@import`s are followed by the build). Tests and fixtures never ship.
function shippedStylesheets(): string[] {
  const stylesheets = new Set<string>()
  for (const file of readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })) {
    const [area] = file.split(/[\\/]/)
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || area === "test" || area === "fixtures") continue
    const importer = join(sourceRoot, file)
    for (const [, specifier] of readFileSync(importer, "utf8").matchAll(/\bimport\s+(?:[^"';]*?\s+from\s+)?["']([^"'?]+\.css)(?:\?[^"']*)?["']/g)) {
      stylesheets.add(specifier.startsWith(".") ? resolve(dirname(importer), specifier)
        : specifier.startsWith("@/") ? join(sourceRoot, specifier.slice(2)) : specifier)
    }
  }
  return [...stylesheets].sort()
}

it("shipped transitions never delay hiding a screen or its descendants", async () => {
  // jsdom does not run CSS animations, so check the compiled stylesheets instead
  // of JSX classes. Building only the stylesheets runs the same Vite and Tailwind
  // pipeline as the production build (Tailwind scans every source file for
  // utilities), producing the same CSS without bundling the application.
  const stylesheets = shippedStylesheets()
  expect(stylesheets).toContain(join(sourceRoot, "index.css"))
  const result = await build({
    root: appRoot,
    configFile: join(appRoot, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false, cssMinify: false, rolldownOptions: { input: stylesheets } },
  })
  if (!("output" in result)) throw new Error("Expected a single stylesheet build")
  const css = result.output.flatMap((file) => (
    file.type === "asset" && file.fileName.endsWith(".css") ? [String(file.source)] : []
  ))
  expect(css).toHaveLength(stylesheets.length)
  const transitions = [...css.join("\n").matchAll(/(?:^|[;{])\s*transition(?:-property)?\s*:\s*([^;}]+)/g)]
  expect(transitions.length).toBeGreaterThan(0)
  for (const [, properties] of transitions) {
    expect(properties, `Unsafe CSS transition: ${properties}`).not.toMatch(/(?:^|[\s,])(?:all|visibility)(?=$|[\s,])/)
  }
}, 10_000)

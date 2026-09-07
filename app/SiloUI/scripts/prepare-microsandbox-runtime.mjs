import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { resolveRuntimeTarget, stageRuntime } from "./microsandbox-runtime.mjs"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const targetTriple = resolveRuntimeTarget(
  process.env,
  () => execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }),
)

const prepared = await stageRuntime({
  appRoot,
  targetTriple,
  fetchBytes: async (url) => {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
    return new Uint8Array(await response.arrayBuffer())
  },
})

console.log(`Prepared bundled MicroSandbox ${prepared.targetTriple}`)

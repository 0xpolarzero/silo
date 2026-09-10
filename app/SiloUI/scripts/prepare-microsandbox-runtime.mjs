import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { resolveRuntimeTarget, stageRuntime } from "./microsandbox-runtime.mjs"
import { stageGitRuntime } from "./git-runtime.mjs"
import { stageGuestImage } from "./guest-image.mjs"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hostTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim()
const targetTriple = resolveRuntimeTarget(process.env, () => hostTriple)

const prepared = await stageRuntime({
  appRoot,
  targetTriple,
  hostTriple,
  fetchBytes: async (url) => {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
    return new Uint8Array(await response.arrayBuffer())
  },
})

const git = await stageGitRuntime({
  appRoot,
  targetTriple,
  fetchBytes: async (url) => {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
    return new Uint8Array(await response.arrayBuffer())
  },
})

console.log(`Prepared bundled MicroSandbox ${prepared.targetTriple}`)
console.log(`Prepared bundled Git ${git.targetTriple}`)

const guest = await stageGuestImage({ appRoot, targetTriple, fetchBytes: async (url) => {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`Guest image download failed (${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
} })
console.log(`Prepared bundled guest ${guest.imageReference}`)

// Signed package metadata lets publication verify version and target without running it.
const { version } = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"))
writeFileSync(resolve(appRoot, "src-tauri/runtime/release-info.json"), JSON.stringify({ version, target: targetTriple }) + "\n")

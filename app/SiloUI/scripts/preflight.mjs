import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const digest = /^[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const version = /^\d+\.\d+\.\d+$/
function requireValue(valid, field) {
  if (!valid) throw new Error(`Runtime preflight: invalid ${field}`)
}
function keys(value, expected, field) {
  requireValue(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...expected].sort().join(), field)
}
function matches(value, pattern, field) {
  requireValue(typeof value === "string" && pattern.test(value), field)
}

// Validate approved inputs without downloads, native tools, credentials or generated files.
// The manifest is the approval boundary: well-formed new upstream digests require review
// and are verified against downloaded bytes by staging, not guessed by this offline check.
export function preflight(root = appRoot) {
  const inputs = JSON.parse(readFileSync(resolve(root, "runtime-inputs.json"), "utf8"))
  keys(inputs, ["schemaVersion", "microsandboxVersion", "libkrunfwVersion", "sourceCommit", "sourceArchiveSha256", "patchPath", "patchSha256", "toolchain", "features", "libkrunfwCommit", "targets", "licenses"], "manifest fields")
  requireValue(inputs.schemaVersion === 1, "schemaVersion")
  for (const key of ["microsandboxVersion", "libkrunfwVersion", "toolchain"]) matches(inputs[key], version, key)
  for (const key of ["sourceCommit", "libkrunfwCommit"]) matches(inputs[key], revision, key)
  for (const key of ["sourceArchiveSha256", "patchSha256"]) matches(inputs[key], digest, key)
  requireValue(inputs.features === "net,ssh", "features (required net,ssh capability set)")
  requireValue(inputs.patchPath === `patches/microsandbox-create-stopped-${inputs.microsandboxVersion}.patch`, "patchPath")
  const patch = realpathSync(resolve(root, inputs.patchPath))
  const path = relative(realpathSync(root), patch)
  requireValue(path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep), "patchPath containment")
  const actual = createHash("sha256").update(readFileSync(patch)).digest("hex")
  requireValue(actual === inputs.patchSha256, `patchSha256: expected ${inputs.patchSha256}, received ${actual}`)
  const platforms = {
    "aarch64-apple-darwin": ["darwin", "aarch64"],
    "aarch64-unknown-linux-gnu": ["linux", "aarch64"],
    "x86_64-unknown-linux-gnu": ["linux", "x86_64"],
  }
  keys(inputs.targets, Object.keys(platforms), "supported targets")
  for (const [target, [platform, arch]] of Object.entries(platforms)) {
    const value = inputs.targets[target]
    keys(value, ["platform", "arch", "executableAsset", "executableSha256", "agentdAsset", "agentdSha256", "libraryAsset", "libraryName", "librarySha256"], `${target} fields`)
    const expected = { platform, arch, executableAsset: `msb-${platform}-${arch}`, agentdAsset: `agentd-${arch}`, libraryAsset: `libkrunfw-${platform}-${arch}.${platform === "darwin" ? "dylib" : "so"}`, libraryName: platform === "darwin" ? `libkrunfw.${inputs.libkrunfwVersion.split(".")[0]}.dylib` : `libkrunfw.so.${inputs.libkrunfwVersion}` }
    for (const [key, wanted] of Object.entries(expected)) requireValue(value[key] === wanted, `${target}.${key}`)
    for (const key of ["executableSha256", "agentdSha256", "librarySha256"]) matches(value[key], digest, `${target}.${key}`)
  }
  requireValue(inputs.targets["aarch64-apple-darwin"].agentdSha256 === inputs.targets["aarch64-unknown-linux-gnu"].agentdSha256, "shared aarch64 agentdSha256")
  const licenseSources = [
    ["microsandbox-Apache-2.0.txt", "microsandbox", inputs.sourceCommit, "LICENSE"],
    ["libkrunfw-LGPL-2.1-only.txt", "libkrunfw", inputs.libkrunfwCommit, "LICENSE-LGPL-2.1-only"],
    ["linux-GPL-2.0-only.txt", "libkrunfw", inputs.libkrunfwCommit, "LICENSE-GPL-2.0-only"],
  ]
  requireValue(Array.isArray(inputs.licenses) && inputs.licenses.length === licenseSources.length, "licenses")
  for (const [index, [name, repo, commit, file]] of licenseSources.entries()) {
    const license = inputs.licenses[index]
    keys(license, ["name", "url", "sha256"], `licenses[${index}]`)
    requireValue(license.name === name && license.url === `https://raw.githubusercontent.com/superradcompany/${repo}/${commit}/${file}`, `licenses[${index}] source`)
    matches(license.sha256, digest, `licenses[${index}].sha256`)
  }
  return inputs
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { preflight(); console.log("Runtime preflight passed (approved inputs and patch digest).") }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

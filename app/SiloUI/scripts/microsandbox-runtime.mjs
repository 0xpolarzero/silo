import { stagePatchedImago } from "./imago-storage-patch.mjs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const inputs = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../runtime-inputs.json"), "utf8"))
export const MICRO_SANDBOX_VERSION = inputs.microsandboxVersion
export const LIBKRUNFW_VERSION = inputs.libkrunfwVersion
export const RELEASE_BASE_URL = `https://github.com/superradcompany/microsandbox/releases/download/v${MICRO_SANDBOX_VERSION}`
const MICROSANDBOX_COMMIT = inputs.sourceCommit
export const MICROSANDBOX_SOURCE_URL = `https://codeload.github.com/superradcompany/microsandbox/tar.gz/${MICROSANDBOX_COMMIT}`
export const MICROSANDBOX_SOURCE_SHA256 = inputs.sourceArchiveSha256
export const MICROSANDBOX_PATCH_PATH = inputs.patchPath
export const MICROSANDBOX_PATCH_SHA256 = inputs.patchSha256
export const MICROSANDBOX_BUILD_TOOLCHAIN = inputs.toolchain
export const MICROSANDBOX_BUILD_FEATURES = inputs.features
export const runtimeTargets = Object.freeze(Object.fromEntries(Object.entries(inputs.targets).map(([target, value]) => [target, Object.freeze(value)])))
export const licenseArtifacts = Object.freeze(inputs.licenses.map(Object.freeze))

export function resolveRuntimeTarget(environment, hostTriple) {
  const explicitTarget = environment.SILO_RUNTIME_TARGET?.trim()
  if (explicitTarget) return explicitTarget
  const tauriTarget = environment.TAURI_ENV_TARGET_TRIPLE?.trim()
  if (tauriTarget) return tauriTarget
  return hostTriple().trim()
}

export function selectRuntime(targetTriple) {
  const selected = runtimeTargets[targetTriple]
  if (!selected) {
    throw new Error(`Unsupported bundled MicroSandbox target: ${targetTriple}`)
  }
  return selected
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function verifySha256(bytes, expected, label) {
  const actual = sha256(bytes)
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`)
  }
}

function assertInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate))
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))) return
  throw new Error(`Refusing to stage outside ${resolve(root)}: ${resolve(candidate)}`)
}

async function validCachedFile(path, expectedSha256) {
  try {
    return (await stat(path)).isFile() && sha256(await readFile(path)) === expectedSha256
  } catch {
    return false
  }
}

async function fetchVerified(fetchBytes, url, expectedSha256, label, cachePath) {
  if (await validCachedFile(cachePath, expectedSha256)) return readFile(cachePath)
  const bytes = Buffer.from(await fetchBytes(url))
  verifySha256(bytes, expectedSha256, label)
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, bytes)
  return bytes
}

function runBuildTool(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  })
}

export function applyRuntimePatch(sourceRoot, patchPath) {
  // Extracted sources live below Silo's checkout. Give Git a local root;
  // otherwise `git apply` can silently skip every path as outside the cwd.
  runBuildTool("/usr/bin/git", ["init", "--quiet"], { cwd: sourceRoot })
  runBuildTool("/usr/bin/git", ["apply", "--check", patchPath], { cwd: sourceRoot })
  runBuildTool("/usr/bin/git", ["apply", patchPath], { cwd: sourceRoot })
}

async function buildPatchedExecutable({
  targetTriple,
  hostTriple,
  sourceArchive,
  patch,
  agentd,
  cacheRoot,
}) {
  if (targetTriple !== hostTriple) {
    throw new Error(`Patched MicroSandbox cross-builds are not supported: host ${hostTriple}, target ${targetTriple}`)
  }
  const rustcVersion = runBuildTool("rustc", [`+${MICROSANDBOX_BUILD_TOOLCHAIN}`, "--version"]).trim()
  const cacheKey = sha256(Buffer.from([
    MICROSANDBOX_SOURCE_SHA256,
    MICROSANDBOX_PATCH_SHA256,
    sha256(agentd),
    rustcVersion,
    targetTriple,
    MICROSANDBOX_BUILD_FEATURES,
  ].join("\n")))
  const buildRoot = join(cacheRoot, "patched-builds", cacheKey)
  const cachedExecutable = join(buildRoot, "msb")
  const cachedDigest = join(buildRoot, "msb.sha256")
  if (await validCachedFile(cachedExecutable, (await readFile(cachedDigest, "utf8").catch(() => "")).trim())) {
    const version = runBuildTool(cachedExecutable, ["--version"]).trim()
    const createHelp = runBuildTool(cachedExecutable, ["create", "--help"])
    const execHelp = runBuildTool(cachedExecutable, ["exec", "--help"])
    const sshHelp = runBuildTool(cachedExecutable, ["ssh", "serve", "--help"])
    const storageProtocol = runBuildTool(cachedExecutable, ["--silo-storage-protocol"]).trim()
    const githubProtocol = runBuildTool(cachedExecutable, ["--silo-github-protocol"]).trim()
    if (sshHelp.includes("--no-start") && sshHelp.includes("--authorized-keys") && sshHelp.includes("--exit-on-stdin-close") && sshHelp.includes("--expected-machine-id") && execHelp.includes("--no-start") && githubProtocol === "1" && storageProtocol === "1" && version === `msb ${MICRO_SANDBOX_VERSION}` && createHelp.includes("--from-snapshot") && createHelp.includes("--no-start") && createHelp.includes("--progress-json")) {
      return readFile(cachedExecutable)
    }
  }

  const workRoot = join(buildRoot, "work")
  const archivePath = join(buildRoot, "source.tar.gz")
  const patchPath = join(buildRoot, "create-stopped.patch")
  const cargoTarget = join(buildRoot, "cargo-target")
  await rm(workRoot, { recursive: true, force: true })
  await mkdir(workRoot, { recursive: true })
  await writeFile(archivePath, sourceArchive)
  await writeFile(patchPath, patch)
  runBuildTool("/usr/bin/tar", ["-xzf", archivePath, "-C", workRoot])
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(workRoot, { withFileTypes: true }))
  const source = entries.filter((entry) => entry.isDirectory()).map((entry) => join(workRoot, entry.name))
  if (source.length !== 1) throw new Error("Pinned MicroSandbox source archive has an unexpected layout")
  applyRuntimePatch(source[0], patchPath)
  runBuildTool("cargo", [`+${MICROSANDBOX_BUILD_TOOLCHAIN}`, "fetch", "--locked", "--target", targetTriple], { cwd: source[0] })
  await stagePatchedImago(source[0])
  const agentdPath = join(source[0], "build", "agentd")
  await mkdir(dirname(agentdPath), { recursive: true })
  await writeFile(agentdPath, agentd, { mode: 0o755 })
  await chmod(agentdPath, 0o755)
  runBuildTool("cargo", [
    `+${MICROSANDBOX_BUILD_TOOLCHAIN}`,
    "build",
    "--locked",
    "--release",
    "--no-default-features",
    "--features",
    MICROSANDBOX_BUILD_FEATURES,
    "--target",
    targetTriple,
    "-p",
    "microsandbox-cli",
  ], { cwd: source[0], env: { ...process.env, CARGO_TARGET_DIR: cargoTarget } })
  const built = join(cargoTarget, targetTriple, "release", "msb")
  const managedSshHelp = runBuildTool(built, ["ssh", "serve", "--help"])
  if (!managedSshHelp.includes("--authorized-keys") || !managedSshHelp.includes("--exit-on-stdin-close") || !managedSshHelp.includes("--expected-machine-id")) {
    throw new Error("The built MicroSandbox is missing managed SSH access support")
  }
  if (runBuildTool(built, ["--silo-github-protocol"]).trim() !== "1") {
    throw new Error("The built MicroSandbox is missing the restricted GitHub credential boundary")
  }
  if (runBuildTool(built, ["--silo-storage-protocol"]).trim() !== "1") {
    throw new Error("The built MicroSandbox is missing capacity-preserving storage reclamation")
  }
  const bytes = await readFile(built)
  await mkdir(buildRoot, { recursive: true })
  await writeFile(`${cachedExecutable}.tmp-${process.pid}`, bytes, { mode: 0o755 })
  await rename(`${cachedExecutable}.tmp-${process.pid}`, cachedExecutable)
  await writeFile(cachedDigest, `${sha256(bytes)}\n`)
  await rm(workRoot, { recursive: true, force: true })
  return bytes
}

export async function stageRuntime({
  appRoot,
  targetTriple,
  hostTriple = targetTriple,
  fetchBytes,
  selected = selectRuntime(targetTriple),
  licenses = licenseArtifacts,
  sourceArtifact = { url: MICROSANDBOX_SOURCE_URL, sha256: MICROSANDBOX_SOURCE_SHA256 },
  buildExecutable = buildPatchedExecutable,
  verifyExecutable = true,
}) {
  const tauriRoot = resolve(appRoot, "src-tauri")
  const binariesRoot = join(tauriRoot, "binaries")
  const runtimeRoot = join(tauriRoot, "runtime")
  const cacheRoot = join(tauriRoot, "target", "runtime-cache", `v${MICRO_SANDBOX_VERSION}`)
  const stagedRoot = join(runtimeRoot, `.staging-${process.pid}`)
  const bundledRoot = join(runtimeRoot, "microsandbox")
  const executablePath = join(binariesRoot, `msb-${targetTriple}`)
  const libraryPath = join(stagedRoot, targetTriple, "lib", selected.libraryName)
  for (const path of [binariesRoot, runtimeRoot, cacheRoot, stagedRoot, bundledRoot, executablePath, libraryPath]) {
    assertInside(tauriRoot, path)
  }

  await rm(stagedRoot, { recursive: true, force: true })
  await mkdir(dirname(libraryPath), { recursive: true })

  await fetchVerified(
    fetchBytes,
    `${RELEASE_BASE_URL}/${selected.executableAsset}`,
    selected.executableSha256,
    selected.executableAsset,
    join(cacheRoot, selected.executableAsset),
  )
  const sourceArchive = await fetchVerified(
    fetchBytes,
    sourceArtifact.url,
    sourceArtifact.sha256,
    "MicroSandbox pinned source",
    join(cacheRoot, `microsandbox-${MICROSANDBOX_COMMIT}.tar.gz`),
  )
  const agentd = await fetchVerified(
    fetchBytes,
    `${RELEASE_BASE_URL}/${selected.agentdAsset}`,
    selected.agentdSha256,
    selected.agentdAsset,
    join(cacheRoot, selected.agentdAsset),
  )
  const patchPath = resolve(appRoot, MICROSANDBOX_PATCH_PATH)
  assertInside(appRoot, patchPath)
  const patch = await readFile(patchPath)
  verifySha256(patch, MICROSANDBOX_PATCH_SHA256, "Silo stopped-create patch")
  const executable = Buffer.from(await buildExecutable({
    appRoot,
    targetTriple,
    hostTriple,
    sourceArchive,
    patch,
    agentd,
    cacheRoot,
  }))
  const library = await fetchVerified(
    fetchBytes,
    `${RELEASE_BASE_URL}/${selected.libraryAsset}`,
    selected.librarySha256,
    selected.libraryAsset,
    join(cacheRoot, selected.libraryAsset),
  )

  await mkdir(binariesRoot, { recursive: true })
  const executableTemporary = `${executablePath}.tmp-${process.pid}`
  await writeFile(executableTemporary, executable, { mode: 0o755 })
  await chmod(executableTemporary, 0o755)
  if (verifyExecutable) {
    const isolatedHome = join(stagedRoot, "verify-home")
    await mkdir(isolatedHome, { recursive: true })
    const environment = {
      ...process.env,
      HOME: isolatedHome,
      MSB_HOME: isolatedHome,
      MSB_PATH: executableTemporary,
      MSB_LIBKRUNFW_PATH: libraryPath,
    }
    const version = runBuildTool(executableTemporary, ["--version"], { env: environment }).trim()
    const createHelp = runBuildTool(executableTemporary, ["create", "--help"], { env: environment })
    const execHelp = runBuildTool(executableTemporary, ["exec", "--help"], { env: environment })
    const sshHelp = runBuildTool(executableTemporary, ["ssh", "serve", "--help"], { env: environment })
    if (!sshHelp.includes("--no-start") || !sshHelp.includes("--authorized-keys") || !sshHelp.includes("--exit-on-stdin-close") || !sshHelp.includes("--expected-machine-id") || !execHelp.includes("--no-start") || version !== `msb ${MICRO_SANDBOX_VERSION}` || !createHelp.includes("--from-snapshot") || !createHelp.includes("--no-start") || !createHelp.includes("--progress-json")) {
      throw new Error("Patched MicroSandbox executable failed its version, stopped-create, or managed SSH capability check")
    }
    await rm(isolatedHome, { recursive: true, force: true })
  }
  await rename(executableTemporary, executablePath)
  await writeFile(libraryPath, library, { mode: 0o644 })

  const licensesRoot = join(stagedRoot, "licenses")
  await mkdir(licensesRoot, { recursive: true })
  for (const license of licenses) {
    const bytes = await fetchVerified(
      fetchBytes,
      license.url,
      license.sha256,
      license.name,
      join(cacheRoot, "licenses", basename(license.url)),
    )
    await writeFile(join(licensesRoot, license.name), bytes, { mode: 0o644 })
  }

  const manifest = {
    schemaVersion: 2,
    microsandboxVersion: MICRO_SANDBOX_VERSION,
    libkrunfwVersion: LIBKRUNFW_VERSION,
    targetTriple,
    executable: {
      bundledName: "msb",
      sha256: sha256(executable),
      sourceCommit: MICROSANDBOX_COMMIT,
      sourceArchiveSha256: MICROSANDBOX_SOURCE_SHA256,
      patchSha256: MICROSANDBOX_PATCH_SHA256,
      toolchain: MICROSANDBOX_BUILD_TOOLCHAIN,
      features: MICROSANDBOX_BUILD_FEATURES,
      officialReleaseAsset: selected.executableAsset,
      officialReleaseSha256: selected.executableSha256,
      embeddedAgentdReleaseAsset: selected.agentdAsset,
      embeddedAgentdReleaseSha256: selected.agentdSha256,
    },
    library: {
      bundledName: selected.libraryName,
      releaseAsset: selected.libraryAsset,
      sha256: selected.librarySha256,
    },
  }
  await writeFile(join(stagedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(bundledRoot, { recursive: true, force: true })
  await rename(stagedRoot, bundledRoot)

  return {
    targetTriple,
    executablePath,
    libraryPath: join(bundledRoot, targetTriple, "lib", selected.libraryName),
    manifestPath: join(bundledRoot, "manifest.json"),
  }
}

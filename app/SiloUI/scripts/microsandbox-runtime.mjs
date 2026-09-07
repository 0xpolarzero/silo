import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

export const MICRO_SANDBOX_VERSION = "0.6.17"
export const LIBKRUNFW_VERSION = "5.6.1"
export const RELEASE_BASE_URL = `https://github.com/superradcompany/microsandbox/releases/download/v${MICRO_SANDBOX_VERSION}`

const SOURCE_BASE_URL = "https://raw.githubusercontent.com"
const MICROSANDBOX_COMMIT = "5eca4de8bf233e57f114140f8c076ea8c96f21ab"
const LIBKRUNFW_COMMIT = "21cb6dce19a615f63e41ecb913334d18560c1364"

export const runtimeTargets = Object.freeze({
  "aarch64-apple-darwin": Object.freeze({
    platform: "darwin",
    arch: "aarch64",
    executableAsset: "msb-darwin-aarch64",
    executableSha256: "2d3b8883da496ca7ec54f4ea122984022160295f9e4df2af198348fd1f24cdde",
    libraryAsset: "libkrunfw-darwin-aarch64.dylib",
    libraryName: "libkrunfw.5.dylib",
    librarySha256: "20b588c2031519cee3ad93fee4b2a0ca4805f2a3c721198911a6248fd34f65e0",
  }),
  "aarch64-unknown-linux-gnu": Object.freeze({
    platform: "linux",
    arch: "aarch64",
    executableAsset: "msb-linux-aarch64",
    executableSha256: "bab283cb12902838cff629f10b28683d322ae8ce09cc2d720e90d1b169857878",
    libraryAsset: "libkrunfw-linux-aarch64.so",
    libraryName: "libkrunfw.so.5.6.1",
    librarySha256: "b5d205d504c3e1876c47dbb674534436b7aabc09b0fdb32d98b5fff438d9a5b6",
  }),
  "x86_64-unknown-linux-gnu": Object.freeze({
    platform: "linux",
    arch: "x86_64",
    executableAsset: "msb-linux-x86_64",
    executableSha256: "7f79c9d0996fac42b4879f4798c6f985f7981b005af0a9b4b8b1ab5e590daee4",
    libraryAsset: "libkrunfw-linux-x86_64.so",
    libraryName: "libkrunfw.so.5.6.1",
    librarySha256: "d395efaa21984cc6934c900519909a12c8148d9688cfc88f9da3b42132ae32c2",
  }),
})

export const licenseArtifacts = Object.freeze([
  Object.freeze({
    name: "microsandbox-Apache-2.0.txt",
    url: `${SOURCE_BASE_URL}/superradcompany/microsandbox/${MICROSANDBOX_COMMIT}/LICENSE`,
    sha256: "a276ca3381fefb9cde42fccae847856085c76027557d62eee83f057eb6c53433",
  }),
  Object.freeze({
    name: "libkrunfw-LGPL-2.1-only.txt",
    url: `${SOURCE_BASE_URL}/superradcompany/libkrunfw/${LIBKRUNFW_COMMIT}/LICENSE-LGPL-2.1-only`,
    sha256: "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
  }),
  Object.freeze({
    name: "linux-GPL-2.0-only.txt",
    url: `${SOURCE_BASE_URL}/superradcompany/libkrunfw/${LIBKRUNFW_COMMIT}/LICENSE-GPL-2.0-only`,
    sha256: "f6b78c087c3ebdf0f3c13415070dd480a3f35d8fc76f3d02180a407c1c812f79",
  }),
])

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

export async function stageRuntime({
  appRoot,
  targetTriple,
  fetchBytes,
  selected = selectRuntime(targetTriple),
  licenses = licenseArtifacts,
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

  const executable = await fetchVerified(
    fetchBytes,
    `${RELEASE_BASE_URL}/${selected.executableAsset}`,
    selected.executableSha256,
    selected.executableAsset,
    join(cacheRoot, selected.executableAsset),
  )
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
    schemaVersion: 1,
    microsandboxVersion: MICRO_SANDBOX_VERSION,
    libkrunfwVersion: LIBKRUNFW_VERSION,
    targetTriple,
    executable: {
      bundledName: "msb",
      releaseAsset: selected.executableAsset,
      sha256: selected.executableSha256,
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

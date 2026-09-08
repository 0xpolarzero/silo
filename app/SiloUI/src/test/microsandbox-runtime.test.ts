import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  applyRuntimePatch,
  runtimeTargets,
  MICROSANDBOX_PATCH_PATH,
  resolveRuntimeTarget,
  selectRuntime,
  sha256,
  stageRuntime,
  verifySha256,
} from "../../scripts/microsandbox-runtime.mjs"

describe("bundled MicroSandbox release staging", () => {
  it("applies a source patch inside another repository without changing the parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "silo-nested-patch-"))
    try {
      execFileSync("git", ["init", "--quiet", parent])
      const source = join(parent, "build", "source")
      await mkdir(source, { recursive: true })
      await writeFile(join(parent, "value.txt"), "parent\n")
      await writeFile(join(source, "value.txt"), "before\n")
      const patch = join(parent, "change.patch")
      await writeFile(patch, "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n")
      applyRuntimePatch(source, patch)
      expect(await readFile(join(source, "value.txt"), "utf8")).toBe("after\n")
      expect(await readFile(join(parent, "value.txt"), "utf8")).toBe("parent\n")
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
  it("uses Tauri's requested target for cross-builds unless explicitly overridden", () => {
    const hostTriple = vi.fn(() => "aarch64-apple-darwin\n")

    expect(resolveRuntimeTarget({ TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu" }, hostTriple))
      .toBe("x86_64-unknown-linux-gnu")
    expect(resolveRuntimeTarget({
      SILO_RUNTIME_TARGET: "aarch64-unknown-linux-gnu",
      TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
    }, hostTriple)).toBe("aarch64-unknown-linux-gnu")
    expect(hostTriple).not.toHaveBeenCalled()
  })

  it.each([
    ["aarch64-apple-darwin", "msb-darwin-aarch64", "libkrunfw.5.dylib"],
    ["aarch64-unknown-linux-gnu", "msb-linux-aarch64", "libkrunfw.so.5.6.1"],
    ["x86_64-unknown-linux-gnu", "msb-linux-x86_64", "libkrunfw.so.5.6.1"],
  ])("selects the published matching pair for %s", (target, executable, library) => {
    expect(selectRuntime(target)).toMatchObject({ executableAsset: executable, libraryName: library })
  })

  it.each(["x86_64-apple-darwin", "aarch64-unknown-linux-musl", "riscv64-unknown-linux-gnu"])(
    "rejects an unsupported target instead of guessing for %s",
    (target) => expect(() => selectRuntime(target)).toThrow(`Unsupported bundled MicroSandbox target: ${target}`),
  )

  it("rejects corrupt bytes with both expected and actual digests", () => {
    const bytes = Buffer.from("corrupt")
    expect(() => verifySha256(bytes, "0".repeat(64), "msb-darwin-aarch64"))
      .toThrow(`expected ${"0".repeat(64)}, received ${sha256(bytes)}`)
  })

  it("does not publish a runtime manifest when a downloaded release asset is corrupt", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-runtime-corrupt-test-"))
    const targetTriple = "aarch64-apple-darwin"
    const selected = { ...runtimeTargets[targetTriple], executableSha256: "0".repeat(64) }

    await expect(stageRuntime({
      appRoot,
      targetTriple,
      selected,
      licenses: [],
      fetchBytes: async () => Buffer.from("corrupt-msb"),
    })).rejects.toThrow("msb-darwin-aarch64 checksum mismatch")
    await expect(stat(join(appRoot, "src-tauri/runtime/microsandbox/manifest.json"))).rejects.toThrow()
  })

  it("stages verified assets at Tauri's target-qualified sidecar and resource paths", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-runtime-test-"))
    const targetTriple = "aarch64-apple-darwin"
    const executable = Buffer.from("fake-msb")
    const agentd = Buffer.from("fake-agentd")
    const library = Buffer.from("fake-libkrunfw")
    const apache = Buffer.from("fake-apache")
    const selected = {
      ...runtimeTargets[targetTriple],
      executableSha256: sha256(executable),
      agentdSha256: sha256(agentd),
      librarySha256: sha256(library),
    }
    const licenses = [{ name: "LICENSE.txt", url: "https://example.test/LICENSE", sha256: sha256(apache) }]
    const patch = await readFile(join(process.cwd(), MICROSANDBOX_PATCH_PATH))
    const source = Buffer.from("fake pinned source")
    const sourceArtifact = { url: "https://example.test/source.tar.gz", sha256: sha256(source) }
    await mkdir(join(appRoot, "patches"), { recursive: true })
    await writeFile(join(appRoot, MICROSANDBOX_PATCH_PATH), patch)

    const fetchBytes = vi.fn(async (url: string) => {
      if (url.endsWith(`/${selected.executableAsset}`)) return executable
      if (url.endsWith(`/${selected.agentdAsset}`)) return agentd
      if (url === sourceArtifact.url) return source
      if (url.endsWith(`/${selected.libraryAsset}`)) return library
      if (url === licenses[0].url) return apache
      throw new Error(`unexpected URL: ${url}`)
    })
    fetchBytes.mockImplementation(async (url: string) => {
      if (url.endsWith(`/${selected.executableAsset}`)) return executable
      if (url.endsWith(`/${selected.agentdAsset}`)) return agentd
      if (url === sourceArtifact.url) return source
      if (url.endsWith(`/${selected.libraryAsset}`)) return library
      if (url === licenses[0].url) return apache
      throw new Error(`unexpected URL: ${url}`)
    })
    const buildExecutable = vi.fn(async () => executable)
    const staged = await stageRuntime({ appRoot, targetTriple, fetchBytes, selected, licenses, sourceArtifact, buildExecutable, verifyExecutable: false })

    expect(staged.executablePath).toBe(join(appRoot, "src-tauri/binaries/msb-aarch64-apple-darwin"))
    expect(staged.libraryPath).toBe(join(appRoot, "src-tauri/runtime/microsandbox/aarch64-apple-darwin/lib/libkrunfw.5.dylib"))
    expect(await readFile(staged.executablePath)).toEqual(executable)
    expect(await readFile(staged.libraryPath)).toEqual(library)
    expect((await stat(staged.executablePath)).mode & 0o777).toBe(0o755)
    const manifest = JSON.parse(await readFile(staged.manifestPath, "utf8"))
    expect(manifest).toMatchObject({
      microsandboxVersion: "0.6.17",
      targetTriple,
      executable: {
        bundledName: "msb",
        sha256: sha256(executable),
        sourceCommit: "5eca4de8bf233e57f114140f8c076ea8c96f21ab",
        patchSha256: sha256(patch),
        officialReleaseAsset: "msb-darwin-aarch64",
      },
      library: { bundledName: "libkrunfw.5.dylib", sha256: sha256(library) },
    })
    expect(manifest.library).not.toHaveProperty("resourcePath")
    expect(buildExecutable).toHaveBeenCalledOnce()
    expect(fetchBytes).toHaveBeenCalledTimes(5)
  })
})

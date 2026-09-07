import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  runtimeTargets,
  resolveRuntimeTarget,
  selectRuntime,
  sha256,
  stageRuntime,
  verifySha256,
} from "../../scripts/microsandbox-runtime.mjs"

describe("bundled MicroSandbox release staging", () => {
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
    const library = Buffer.from("fake-libkrunfw")
    const apache = Buffer.from("fake-apache")
    const selected = {
      ...runtimeTargets[targetTriple],
      executableSha256: sha256(executable),
      librarySha256: sha256(library),
    }
    const licenses = [{ name: "LICENSE.txt", url: "https://example.test/LICENSE", sha256: sha256(apache) }]

    const fetchBytes = vi.fn(async (url: string) => {
      if (url.endsWith(`/${selected.executableAsset}`)) return executable
      if (url.endsWith(`/${selected.libraryAsset}`)) return library
      if (url === licenses[0].url) return apache
      throw new Error(`unexpected URL: ${url}`)
    })
    const staged = await stageRuntime({ appRoot, targetTriple, fetchBytes, selected, licenses })

    expect(staged.executablePath).toBe(join(appRoot, "src-tauri/binaries/msb-aarch64-apple-darwin"))
    expect(staged.libraryPath).toBe(join(appRoot, "src-tauri/runtime/microsandbox/aarch64-apple-darwin/lib/libkrunfw.5.dylib"))
    expect(await readFile(staged.executablePath)).toEqual(executable)
    expect(await readFile(staged.libraryPath)).toEqual(library)
    expect((await stat(staged.executablePath)).mode & 0o777).toBe(0o755)
    const manifest = JSON.parse(await readFile(staged.manifestPath, "utf8"))
    expect(manifest).toMatchObject({
      microsandboxVersion: "0.6.17",
      targetTriple,
      executable: { releaseAsset: "msb-darwin-aarch64", sha256: sha256(executable) },
      library: { bundledName: "libkrunfw.5.dylib", sha256: sha256(library) },
    })
    expect(manifest.library).not.toHaveProperty("resourcePath")
    expect(fetchBytes).toHaveBeenCalledTimes(3)
  })
})

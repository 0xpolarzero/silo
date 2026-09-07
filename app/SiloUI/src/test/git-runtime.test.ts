import { execFileSync } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  gitRuntimeSha256,
  gitRuntimeTargets,
  selectGitRuntime,
  stageGitRuntime,
  validateArchiveEntries,
  verifyGitRuntimeSha256,
} from "../../scripts/git-runtime.mjs"

async function createFixtureArchive(root: string, withCertificateBundle = false) {
  const source = join(root, "source")
  const archive = join(root, "git.tar.gz")
  await mkdir(join(source, "bin"), { recursive: true })
  await mkdir(join(source, "libexec/git-core"), { recursive: true })
  await mkdir(join(source, "share/git-core/templates"), { recursive: true })
  for (const file of ["bin/git", "libexec/git-core/git", "libexec/git-core/git-lfs", "libexec/git-core/git-remote-http"]) {
    await writeFile(join(source, file), `fixture ${file}\n`)
    await chmod(join(source, file), 0o755)
  }
  await symlink("git-remote-http", join(source, "libexec/git-core/git-remote-https"))
  if (withCertificateBundle) {
    await mkdir(join(source, "ssl"))
    await writeFile(join(source, "ssl/cacert.pem"), "fixture certificates\n")
  }
  execFileSync("tar", ["-czf", archive, "-C", source, "."])
  return { archive, bytes: await readFile(archive) }
}

describe("bundled Git release staging", () => {
  it.each([
    ["aarch64-apple-darwin", "macOS-arm64", false],
    ["aarch64-unknown-linux-gnu", "ubuntu-arm64", true],
    ["x86_64-unknown-linux-gnu", "ubuntu-x64", true],
  ])("selects the pinned portable archive for %s", (target, assetPart, needsCertificateBundle) => {
    expect(selectGitRuntime(target)).toMatchObject({ needsCertificateBundle })
    expect(selectGitRuntime(target).archive).toContain(assetPart)
  })

  it.each(["x86_64-apple-darwin", "aarch64-unknown-linux-musl", "riscv64-unknown-linux-gnu"])(
    "rejects unsupported target %s",
    (target) => expect(() => selectGitRuntime(target)).toThrow(`Unsupported bundled Git target: ${target}`),
  )

  it("rejects corrupt release bytes", () => {
    const bytes = Buffer.from("corrupt")
    expect(() => verifyGitRuntimeSha256(bytes, "0".repeat(64), "dugite archive"))
      .toThrow(`expected ${"0".repeat(64)}, received ${gitRuntimeSha256(bytes)}`)
  })

  it("rejects unsafe or empty archive inventories", () => {
    expect(() => validateArchiveEntries([], "archive")).toThrow("archive is empty")
    expect(() => validateArchiveEntries(["./bin/git", "../outside"], "archive"))
      .toThrow("archive contains an unsafe path: ../outside")
    expect(() => validateArchiveEntries(["/absolute"], "archive"))
      .toThrow("archive contains an unsafe path: /absolute")
  })

  it("does not replace a published runtime after an integrity failure", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-git-corrupt-test-"))
    const published = join(appRoot, "src-tauri/runtime/git")
    await mkdir(published, { recursive: true })
    await writeFile(join(published, "manifest.json"), "existing\n")
    const selected = { ...gitRuntimeTargets["aarch64-apple-darwin"], sha256: "0".repeat(64) }

    await expect(stageGitRuntime({
      appRoot,
      targetTriple: "aarch64-apple-darwin",
      selected,
      licenses: [],
      fetchBytes: async () => Buffer.from("corrupt"),
    })).rejects.toThrow("checksum mismatch")
    expect(await readFile(join(published, "manifest.json"), "utf8")).toBe("existing\n")
  })

  it("preserves the helper layout, executable modes, links, and manifest", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-git-runtime-test-"))
    const fixture = await createFixtureArchive(appRoot)
    const license = Buffer.from("fixture license\n")
    const selected = {
      ...gitRuntimeTargets["aarch64-apple-darwin"],
      archive: "fixture.tar.gz",
      sha256: gitRuntimeSha256(fixture.bytes),
    }
    const licenses = [{ name: "LICENSE.txt", url: "https://example.test/LICENSE", sha256: gitRuntimeSha256(license) }]
    const fetchBytes = vi.fn(async (url: string) => url === licenses[0].url ? license : fixture.bytes)

    const staged = await stageGitRuntime({
      appRoot,
      targetTriple: "aarch64-apple-darwin",
      selected,
      licenses,
      fetchBytes,
    })

    expect((await stat(staged.gitPath)).mode & 0o777).toBe(0o755)
    expect((await stat(staged.gitLfsPath)).mode & 0o111).not.toBe(0)
    expect((await stat(staged.externalBinaries.git)).mode & 0o111).not.toBe(0)
    expect(await readFile(staged.externalBinaries.git)).toEqual(await readFile(staged.gitPath))
    expect((await lstat(staged.externalBinaries.gitRemoteHttps)).isFile()).toBe(true)
    expect((await lstat(join(staged.root, "libexec/git-core/git-remote-https"))).isSymbolicLink()).toBe(true)
    await expect(stat(join(staged.root, "libexec/git-core/git"))).rejects.toThrow()
    expect(await readFile(join(staged.root, "licenses/LICENSE.txt"))).toEqual(license)
    expect(JSON.parse(await readFile(staged.manifestPath, "utf8"))).toMatchObject({
      targetTriple: "aarch64-apple-darwin",
      gitVersion: "2.53.0",
      gitVersionOutput: "git version 2.53.0",
      gitLfsVersion: "3.7.1",
      archive: { name: "fixture.tar.gz", sha256: gitRuntimeSha256(fixture.bytes) },
      paths: {
        git: "bin/git",
        gitLfs: "libexec/git-core/git-lfs",
        packagedResourceDirectory: "git-support",
      },
    })
    expect(fetchBytes).toHaveBeenCalledTimes(2)
  })

  it("rejects an archive that omits an HTTPS helper", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-git-layout-test-"))
    const selected = gitRuntimeTargets["aarch64-apple-darwin"]
    const archive = Buffer.from("fixture archive")

    await expect(stageGitRuntime({
      appRoot,
      targetTriple: "aarch64-apple-darwin",
      selected: { ...selected, archive: "fixture.tar.gz", sha256: gitRuntimeSha256(archive) },
      licenses: [],
      fetchBytes: async () => archive,
      extractArchive: async (_archive: string, destination: string) => {
        await mkdir(join(destination, "bin"), { recursive: true })
        await mkdir(join(destination, "libexec/git-core"), { recursive: true })
        await mkdir(join(destination, "share/git-core/templates"), { recursive: true })
        for (const file of ["bin/git", "libexec/git-core/git-lfs"]) {
          await writeFile(join(destination, file), "incomplete")
          await chmod(join(destination, file), 0o755)
        }
      },
    })).rejects.toThrow("Bundled Git archive is missing libexec/git-core/git-remote-http")
  })

  it("rejects a required helper link that leaves the portable tree", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "silo-git-link-test-"))
    const fixture = await createFixtureArchive(appRoot)
    const selected = {
      ...gitRuntimeTargets["aarch64-apple-darwin"],
      archive: "fixture.tar.gz",
      sha256: gitRuntimeSha256(fixture.bytes),
    }

    await expect(stageGitRuntime({
      appRoot,
      targetTriple: "aarch64-apple-darwin",
      selected,
      licenses: [],
      fetchBytes: async () => fixture.bytes,
      extractArchive: async (_archive: string, destination: string) => {
        const outside = join(appRoot, "outside")
        await mkdir(join(destination, "bin"), { recursive: true })
        await mkdir(join(destination, "libexec/git-core"), { recursive: true })
        await mkdir(join(destination, "share/git-core/templates"), { recursive: true })
        for (const file of ["bin/git", "libexec/git-core/git-lfs", "libexec/git-core/git-remote-http"]) {
          await writeFile(join(destination, file), "fixture")
          await chmod(join(destination, file), 0o755)
        }
        await writeFile(outside, "outside")
        await chmod(outside, 0o755)
        await symlink(outside, join(destination, "libexec/git-core/git-remote-https"))
      },
    })).rejects.toThrow("Refusing to stage outside")
  })

  it("packages every Git executable through Tauri's signed sidecar path", async () => {
    const config = JSON.parse(await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"))
    expect(config.bundle.externalBin).toEqual(expect.arrayContaining([
      "binaries/git",
      "binaries/git-lfs",
      "binaries/git-remote-http",
      "binaries/git-remote-https",
    ]))
    expect(config.bundle.resources).not.toHaveProperty("runtime/git/")
  })

  it("declares Linux Git transport dependencies and AppImage inputs", async () => {
    const config = JSON.parse(await readFile(resolve("src-tauri/tauri.linux.conf.json"), "utf8"))
    expect(config.bundle.linux.deb.depends).toEqual(expect.arrayContaining([
      "libc6 (>= 2.34)",
      "libcurl4 | libcurl4t64",
      "zlib1g",
    ]))
    expect(config.bundle.linux.rpm.depends).toEqual(expect.arrayContaining(["glibc", "libcurl", "zlib"]))
    expect(config.bundle.resources["runtime/git/ssl/"]).toBe("git-support/ssl/")
  })
})

import { Readable } from "node:stream"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { guestArchitecture, stageGuestImage, verifyGuestArchive } from "../../scripts/guest-image.mjs"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const bytes = Buffer.from("approved archive")
const manifest = { schemaVersion: 1, architecture: "aarch64", imageReference: "silo:test", archiveBytes: bytes.length, archiveSha256: createHash("sha256").update(bytes).digest("hex") }
async function setup() {
  const appRoot = await mkdtemp(join(tmpdir(), "silo-guest-test-"))
  directories.push(appRoot)
  await mkdir(join(appRoot, "guest-image"))
  await writeFile(join(appRoot, "guest-image/image-lock.json"), JSON.stringify({ releaseUrl: "https://example.test/release", images: { arm64: manifest } }))
  return appRoot
}
it("selects only supported architectures", () => {
  expect(guestArchitecture("aarch64-apple-darwin")).toBe("arm64")
  expect(guestArchitecture("x86_64-unknown-linux-gnu")).toBe("amd64")
  expect(() => guestArchitecture("x86_64-apple-darwin")).toThrow("Unsupported")
})
it("rejects truncated and altered archives", async () => {
  const appRoot = await setup()
  const archive = join(appRoot, "image.tar.gz")
  await writeFile(archive, bytes.subarray(1))
  await expect(verifyGuestArchive(archive, manifest)).rejects.toThrow("checksum")
  await writeFile(archive, Buffer.alloc(bytes.length))
  await expect(verifyGuestArchive(archive, manifest)).rejects.toThrow("checksum")
})
it("downloads once and reuses a verified archive", async () => {
  const appRoot = await setup()
  const fetchStream = vi.fn(async () => Readable.from([bytes]))
  await stageGuestImage({ appRoot, targetTriple: "aarch64-apple-darwin", fetchStream })
  await stageGuestImage({ appRoot, targetTriple: "aarch64-apple-darwin", fetchStream })
  expect(fetchStream).toHaveBeenCalledExactlyOnceWith("https://example.test/release/image-arm64.tar.gz", { signal: expect.any(AbortSignal) })
  expect(JSON.parse(await readFile(join(appRoot, "src-tauri/runtime/guest-image/manifest.json"), "utf8"))).toEqual(manifest)
})
it("never stages a corrupt download", async () => {
  const appRoot = await setup()
  await expect(stageGuestImage({ appRoot, targetTriple: "aarch64-apple-darwin", fetchStream: async () => Readable.from([Buffer.from("corrupt")]) })).rejects.toThrow("checksum")
  await expect(readFile(join(appRoot, "src-tauri/runtime/guest-image/image.tar.gz"))).rejects.toThrow()
})
it("replaces a damaged cache only after verifying its replacement", async () => {
  const appRoot = await setup()
  const destination = join(appRoot, "src-tauri/runtime/guest-image")
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, "image.tar.gz"), "broken")
  const fetchStream = vi.fn(async () => Readable.from([bytes]))
  await stageGuestImage({ appRoot, targetTriple: "aarch64-apple-darwin", fetchStream })
  expect(fetchStream).toHaveBeenCalledOnce()
  expect(await readFile(join(destination, "image.tar.gz"))).toEqual(bytes)
})
it("uses verified local artifacts without downloading", async () => {
  const appRoot = await setup()
  const artifacts = join(appRoot, "src-tauri/guest-image-artifacts/arm64")
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, "image.tar.gz"), bytes)
  const fetchStream = vi.fn(async () => { throw new Error("offline") })
  await stageGuestImage({ appRoot, targetTriple: "aarch64-apple-darwin", fetchStream })
  expect(fetchStream).not.toHaveBeenCalled()
})

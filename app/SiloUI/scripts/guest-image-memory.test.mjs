import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import test from "node:test"
import { promisify } from "node:util"

const execute = promisify(execFile)

test("warm guest verification stays below an archive-sized RSS increase", async t => {
  const appRoot = await mkdtemp(join(tmpdir(), "silo-guest-memory-"))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  const archiveBytes = 256 * 1024 * 1024
  const destination = join(appRoot, "src-tauri/runtime/guest-image")
  await mkdir(destination, { recursive: true })
  await mkdir(join(appRoot, "guest-image"))
  const hash = createHash("sha256")
  const chunk = Buffer.alloc(1024 * 1024, 0x61)
  await pipeline(Readable.from((function* () {
    for (let written = 0; written < archiveBytes; written += chunk.length) { hash.update(chunk); yield chunk }
  })()), createWriteStream(join(destination, "image.tar.gz")))
  const manifest = { schemaVersion: 1, architecture: "aarch64", imageReference: "synthetic:test", archiveBytes, archiveSha256: hash.digest("hex") }
  await writeFile(join(appRoot, "guest-image/image-lock.json"), JSON.stringify({ images: { arm64: manifest } }))
  const moduleUrl = new URL("./guest-image.mjs", import.meta.url).href
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", `
    const { stageGuestImage } = await import(process.argv[1])
    const before = process.resourceUsage().maxRSS
    await stageGuestImage({ appRoot: process.argv[2], targetTriple: "aarch64-apple-darwin",
      fetchStream: async () => { throw new Error("Verified cache must not download") } })
    console.log(process.resourceUsage().maxRSS - before)
  `, moduleUrl, appRoot], { timeout: 30_000 })
  const increaseKiB = Number(stdout.trim())
  assert.ok(Number.isFinite(increaseKiB) && increaseKiB < 192 * 1024, `Peak RSS increased by ${increaseKiB / 1024} MiB for a 256 MiB cached archive`)
})

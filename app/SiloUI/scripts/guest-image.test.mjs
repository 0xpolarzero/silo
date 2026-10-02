import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"
import { stageGuestImage } from "./guest-image.mjs"

const bytes = Buffer.from("approved archive")
const manifest = { schemaVersion: 1, architecture: "aarch64", imageReference: "silo:test", archiveBytes: bytes.length, archiveSha256: createHash("sha256").update(bytes).digest("hex") }
async function setup(t) {
  const appRoot = await mkdtemp(join(tmpdir(), "silo-guest-stream-"))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  await mkdir(join(appRoot, "guest-image"))
  await writeFile(join(appRoot, "guest-image/image-lock.json"), JSON.stringify({ releaseUrl: "https://example.test/release", images: { arm64: manifest } }))
  const destination = join(appRoot, "src-tauri/runtime/guest-image")
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, "image.tar.gz"), "previous archive")
  await writeFile(join(destination, "manifest.json"), "previous manifest")
  return { appRoot, destination, targetTriple: "aarch64-apple-darwin" }
}

test("publishes a chunked guest archive only after its final byte is verified", async t => {
  const options = await setup(t)
  let downloads = 0
  await stageGuestImage({ ...options, fetchStream: async () => {
    downloads += 1
    return Readable.from((async function* () {
      yield bytes.subarray(0, 4)
      assert.equal(await readFile(join(options.destination, "image.tar.gz"), "utf8"), "previous archive")
      assert.equal(await readFile(join(options.destination, "manifest.json"), "utf8"), "previous manifest")
      yield bytes.subarray(4)
    })())
  } })
  await stageGuestImage({ ...options, fetchStream: async () => { throw new Error("Warm cache must not download") } })
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(join(options.destination, "image.tar.gz")), bytes)
  assert.deepEqual(JSON.parse(await readFile(join(options.destination, "manifest.json"), "utf8")), manifest)
  assert.deepEqual((await readdir(options.destination)).sort(), ["image.tar.gz", "manifest.json"])
})

for (const failure of ["truncated", "checksum", "interrupted", "oversized"]) {
  test(`${failure} guest stream preserves the previous archive and manifest and removes temporary files`, async t => {
    const options = await setup(t)
    let source
    await assert.rejects(stageGuestImage({ ...options, fetchStream: async () => {
      source = Readable.from((async function* () {
        if (failure === "truncated") yield bytes.subarray(1)
        if (failure === "checksum") yield Buffer.alloc(bytes.length)
        if (failure === "interrupted") { yield bytes.subarray(0, 4); throw new Error("connection lost") }
        if (failure === "oversized") { for (let i = 0; i < 1000; i += 1) yield bytes }
      })())
      return source
    } }), failure === "interrupted" ? /connection lost/ : /checksum mismatch|size limit/)
    assert.equal(source.destroyed, true)
    assert.equal(await readFile(join(options.destination, "image.tar.gz"), "utf8"), "previous archive")
    assert.equal(await readFile(join(options.destination, "manifest.json"), "utf8"), "previous manifest")
    assert.deepEqual((await readdir(options.destination)).sort(), ["image.tar.gz", "manifest.json"])
  })
}


test("a corrupt local artifact falls back to a verified streamed download", async t => {
  const options = await setup(t)
  const localRoot = join(options.appRoot, "src-tauri/guest-image-artifacts/arm64")
  await mkdir(localRoot, { recursive: true })
  await writeFile(join(localRoot, "image.tar.gz"), Buffer.alloc(bytes.length))
  let downloads = 0
  await stageGuestImage({ ...options, fetchStream: async () => {
    downloads += 1
    return Readable.from([bytes])
  } })
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(join(options.destination, "image.tar.gz")), bytes)
  assert.deepEqual((await readdir(options.destination)).sort(), ["image.tar.gz", "manifest.json"])
})


for (const [targetTriple, key, declared] of [
  ["aarch64-apple-darwin", "arm64", "x86_64"],
  ["aarch64-unknown-linux-gnu", "arm64", "x86_64"],
  ["x86_64-unknown-linux-gnu", "amd64", "aarch64"],
]) {
  test(`rejects a ${declared} guest lock for ${targetTriple} before replacing cached artifacts`, async t => {
    const options = await setup(t)
    await writeFile(join(options.appRoot, "guest-image/image-lock.json"), JSON.stringify({
      releaseUrl: "https://example.test/release", images: { [key]: { ...manifest, architecture: declared } },
    }))
    let downloads = 0
    await assert.rejects(stageGuestImage({ ...options, targetTriple, fetchStream: async () => {
      downloads += 1
      return Readable.from([bytes])
    } }), /invalid locked guest image/)
    assert.equal(downloads, 0)
    assert.equal(await readFile(join(options.destination, "image.tar.gz"), "utf8"), "previous archive")
    assert.equal(await readFile(join(options.destination, "manifest.json"), "utf8"), "previous manifest")
  })
}


test("stages and reuses an approved x86_64 guest for the amd64 lock entry", async t => {
  const options = await setup(t)
  const amd64 = { ...manifest, architecture: "x86_64" }
  await writeFile(join(options.appRoot, "guest-image/image-lock.json"), JSON.stringify({
    releaseUrl: "https://example.test/release", images: { amd64 },
  }))
  let downloads = 0
  const fetchStream = async url => {
    downloads += 1
    assert.equal(url, "https://example.test/release/image-amd64.tar.gz")
    return Readable.from([bytes])
  }
  await stageGuestImage({ ...options, targetTriple: "x86_64-unknown-linux-gnu", fetchStream })
  await stageGuestImage({ ...options, targetTriple: "x86_64-unknown-linux-gnu", fetchStream })
  assert.equal(downloads, 1)
  assert.deepEqual(JSON.parse(await readFile(join(options.destination, "manifest.json"), "utf8")), amd64)
})

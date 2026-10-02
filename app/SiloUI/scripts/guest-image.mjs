import { createReadStream } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isVerifiedFile, verifyFile, writeVerifiedFile } from "./build-input.mjs"

export function guestArchitecture(targetTriple) {
  if (["aarch64-apple-darwin", "aarch64-unknown-linux-gnu"].includes(targetTriple)) return "arm64"
  if (targetTriple === "x86_64-unknown-linux-gnu") return "amd64"
  throw new Error(`Unsupported guest image target: ${targetTriple}`)
}
export async function verifyGuestArchive(path, manifest) {
  await verifyFile(path, manifest.archiveSha256, "Bundled guest image", { bytes: manifest.archiveBytes })
}
export async function stageGuestImage({ appRoot, targetTriple, fetchStream }) {
  const architecture = guestArchitecture(targetTriple)
  const lock = JSON.parse(await readFile(join(appRoot, "guest-image/image-lock.json"), "utf8"))
  const manifest = lock.images[architecture]
  if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.archiveBytes) || manifest.archiveBytes < 1) {
    throw new Error(`Missing or invalid locked guest image for ${architecture}`)
  }
  const destination = join(appRoot, "src-tauri/runtime/guest-image")
  await mkdir(destination, { recursive: true })
  const archive = join(destination, "image.tar.gz")
  const limits = { bytes: manifest.archiveBytes }
  if (!await isVerifiedFile(archive, manifest.archiveSha256, "Bundled guest image", limits)) {
    // Developers can stage the exact approved artifact without a network fetch.
    const local = join(appRoot, "src-tauri/guest-image-artifacts", architecture, "image.tar.gz")
    try {
      await writeVerifiedFile(archive, async () => createReadStream(local, { highWaterMark: 1024 * 1024 }), manifest.archiveSha256, "Bundled guest image", limits)
    } catch (error) {
      if (!["ENOENT", "ERR_BUILD_INPUT_CHECKSUM", "ERR_BUILD_INPUT_SIZE"].includes(error.code)) throw error
      await writeVerifiedFile(archive, signal => fetchStream(`${lock.releaseUrl}/image-${architecture}.tar.gz`, { signal }), manifest.archiveSha256, "Bundled guest image", limits)
    }
  }
  const temporaryManifest = join(destination, `manifest.json.${process.pid}.tmp`)
  try {
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(temporaryManifest, join(destination, "manifest.json"))
  } finally { await rm(temporaryManifest, { force: true }) }
  return manifest
}

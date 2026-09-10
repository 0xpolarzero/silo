import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export function guestArchitecture(targetTriple) {
  if (["aarch64-apple-darwin", "aarch64-unknown-linux-gnu"].includes(targetTriple)) return "arm64"
  if (targetTriple === "x86_64-unknown-linux-gnu") return "amd64"
  throw new Error(`Unsupported guest image target: ${targetTriple}`)
}
export function verifyGuestArchive(bytes, manifest) {
  if (bytes.byteLength !== manifest.archiveBytes || createHash("sha256").update(bytes).digest("hex") !== manifest.archiveSha256) {
    throw new Error("Bundled guest image checksum mismatch. Obtain the exact published image artifact.")
  }
}
export async function stageGuestImage({ appRoot, targetTriple, fetchBytes }) {
  const architecture = guestArchitecture(targetTriple)
  const lock = JSON.parse(await readFile(join(appRoot, "guest-image/image-lock.json"), "utf8"))
  const manifest = lock.images[architecture]
  if (!manifest || manifest.schemaVersion !== 1) throw new Error(`Missing locked guest image for ${architecture}`)
  const destination = join(appRoot, "src-tauri/runtime/guest-image")
  await mkdir(destination, { recursive: true })
  let bytes
  try {
    bytes = await readFile(join(destination, "image.tar.gz"))
    verifyGuestArchive(bytes, manifest)
  } catch {
    // Developers can stage the exact approved artifact without a network fetch.
    try {
      bytes = await readFile(join(appRoot, "src-tauri/guest-image-artifacts", architecture, "image.tar.gz"))
      verifyGuestArchive(bytes, manifest)
    } catch {
      bytes = await fetchBytes(`${lock.releaseUrl}/image-${architecture}.tar.gz`)
      verifyGuestArchive(bytes, manifest)
    }
    const temporary = join(destination, `image.tar.gz.${process.pid}.tmp`)
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, join(destination, "image.tar.gz"))
    } finally { await rm(temporary, { force: true }) }
  }
  const temporaryManifest = join(destination, `manifest.json.${process.pid}.tmp`)
  try {
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(temporaryManifest, join(destination, "manifest.json"))
  } finally { await rm(temporaryManifest, { force: true }) }
  return manifest
}

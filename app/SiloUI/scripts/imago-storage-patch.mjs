import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Only this dependency is copied. The source archive and patch are pinned by the
// runtime inputs; its crate archive is verified against that source's lockfile.
export async function stagePatchedImago(sourceRoot, cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo")) {
  const lockPath = join(sourceRoot, "Cargo.lock")
  const lock = await readFile(lockPath, "utf8")
  const blocks = lock.split("[[package]]")
  const index = blocks.findIndex(block => /^\s*name = "msb-imago"\nversion = "0.1.5"\n/m.test(block))
  if (index < 0) throw new Error("Pinned msb-imago 0.1.5 dependency is missing")
  const packageBlock = blocks[index]
  const checksum = packageBlock.match(/^checksum = "([a-f0-9]{64})"$/m)?.[1]
  if (!checksum || !packageBlock.includes('source = "registry+https://github.com/rust-lang/crates.io-index"')) throw new Error("Unexpected imago dependency source")
  const cacheRoot = join(cargoHome, "registry", "cache")
  let archive
  for (const registry of await readdir(cacheRoot)) {
    const candidate = join(cacheRoot, registry, "msb-imago-0.1.5.crate")
    const bytes = await readFile(candidate).catch(() => null)
    if (bytes && createHash("sha256").update(bytes).digest("hex") === checksum) { archive = candidate; break }
  }
  if (!archive) throw new Error("The checksum-verified msb-imago crate archive is unavailable")
  const vendor = join(sourceRoot, "silo-vendor")
  await mkdir(vendor, { recursive: true })
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", vendor])
  const crate = join(vendor, "msb-imago-0.1.5")
  const patch = join(sourceRoot, "silo-imago-preserve-length.patch")
  execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: crate })
  execFileSync("/usr/bin/git", ["apply", "--unidiff-zero", "--check", patch], { cwd: crate })
  execFileSync("/usr/bin/git", ["apply", "--unidiff-zero", patch], { cwd: crate })
  const manifestPath = join(sourceRoot, "Cargo.toml")
  const manifest = await readFile(manifestPath, "utf8")
  if (manifest.includes("[patch.crates-io]")) throw new Error("Review existing Cargo overrides before patching imago")
  await writeFile(manifestPath, `${manifest}\n[patch.crates-io]\nmsb-imago = { path = "silo-vendor/msb-imago-0.1.5" }\n`)
  // A path override changes only the package source. Keep every resolved version
  // and dependency byte-for-byte; the subsequent --locked build verifies it.
  blocks[index] = packageBlock.replace(/^source = .*\n/m, "").replace(/^checksum = .*\n/m, "")
  await writeFile(lockPath, blocks.join("[[package]]"))
}

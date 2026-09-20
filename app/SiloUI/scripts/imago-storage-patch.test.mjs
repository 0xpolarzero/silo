import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { stagePatchedImago } from "./imago-storage-patch.mjs"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "silo-imago-patch-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cargo = join(root, "cargo")
  const cache = join(cargo, "registry", "cache", "test-index")
  const archiveSource = join(root, "crate")
  const source = join(root, "source")
  await mkdir(join(archiveSource, "msb-imago-0.1.5", "src"), { recursive: true })
  await mkdir(cache, { recursive: true })
  await mkdir(source)
  await writeFile(join(archiveSource, "msb-imago-0.1.5", "src", "file.rs"), "unsafe tail truncate\n")
  const archive = join(cache, "msb-imago-0.1.5.crate")
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", archiveSource, "msb-imago-0.1.5"])
  const checksum = createHash("sha256").update(await readFile(archive)).digest("hex")
  const imago = `\nname = "msb-imago"\nversion = "0.1.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\ndependencies = ["other"]\n\n`
  const other = '\nname = "other"\nversion = "9.8.7"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "unchanged"\n'
  await writeFile(join(source, "Cargo.lock"), `version = 4\n[[package]]${imago}[[package]]${other}`)
  await writeFile(join(source, "Cargo.toml"), '[workspace]\nmembers = []\n')
  await writeFile(join(source, "silo-imago-preserve-length.patch"), '--- a/src/file.rs\n+++ b/src/file.rs\n@@ -1 +1 @@\n-unsafe tail truncate\n+preserve logical length\n')
  return { source, cargo, archive, other }
}

test("patches only the verified imago crate and preserves every other locked dependency", async t => {
  const { source, cargo, other } = await fixture(t)
  await stagePatchedImago(source, cargo)
  assert.equal(await readFile(join(source, "silo-vendor", "msb-imago-0.1.5", "src", "file.rs"), "utf8"), "preserve logical length\n")
  const lock = await readFile(join(source, "Cargo.lock"), "utf8")
  assert.equal(lock.split("[[package]]")[2], other)
  assert.equal(lock.split("[[package]]")[1], '\nname = "msb-imago"\nversion = "0.1.5"\ndependencies = ["other"]\n\n')
  assert.match(await readFile(join(source, "Cargo.toml"), "utf8"), /msb-imago = \{ path = "silo-vendor\/msb-imago-0.1.5" \}/)
})

test("rejects a changed crate archive before patching or changing the lockfile", async t => {
  const { source, cargo, archive } = await fixture(t)
  const lock = await readFile(join(source, "Cargo.lock"), "utf8")
  await writeFile(archive, "tampered")
  await assert.rejects(stagePatchedImago(source, cargo), /checksum-verified/)
  assert.equal(await readFile(join(source, "Cargo.lock"), "utf8"), lock)
})

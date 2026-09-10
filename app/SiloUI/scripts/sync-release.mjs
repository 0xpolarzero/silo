import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Changesets owns the version and changelog; mirror them into desktop metadata. */
export function syncRelease(root = app) {
  const read = path => readFileSync(resolve(root, path), "utf8")
  const version = JSON.parse(read("package.json")).version
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version === "0.0.0") {
    throw new Error("Desktop releases require a nonzero stable version.")
  }
  const changelog = read("CHANGELOG.md")
  const heading = `## ${version}`
  const lines = changelog.split("\n")
  const start = lines.indexOf(heading)
  if (start < 0) throw new Error(`No changelog for ${version}. Run npm run release:version first.`)
  const next = lines.findIndex((line, index) => index > start && /^## \d+\.\d+\.\d+(?:\s|$)/.test(line))
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim()
  if (!notes) throw new Error(`Release notes for ${version} are empty.`)

  const lock = JSON.parse(read("package-lock.json"))
  if (!lock.packages?.[""] || lock.name !== "silo-ui") throw new Error("Unexpected npm lockfile structure.")
  lock.version = version
  lock.packages[""].version = version
  // Update only Silo's package stanza, preserving every dependency and checksum.
  const replaceVersion = (text, section) => {
    let count = 0
    const updated = text.replace(section, block => {
      if (!/^name = "silo-ui"$/m.test(block)) return block
      return block.replace(/^version = "[^"]+"$/m, () => { count++; return `version = "${version}"` })
    })
    if (count !== 1) throw new Error("Expected exactly one silo-ui version in Rust metadata.")
    return updated
  }
  const cargo = replaceVersion(read("src-tauri/Cargo.toml"), /^\[package\]\n[\s\S]*?(?=^\[|(?![\s\S]))/gm)
  const cargoLock = replaceVersion(read("src-tauri/Cargo.lock"), /^\[\[package\]\]\n[\s\S]*?(?=^\[\[package\]\]|(?![\s\S]))/gm)
  const notesPath = resolve(root, "../../docs/releases", `${version}.md`)
  const content = `# Silo ${version}\n\n${notes}\n`
  // A retry must preserve reviewed notes, never silently replace an existing release.
  if (existsSync(notesPath) && readFileSync(notesPath, "utf8") !== content) {
    throw new Error(`${notesPath} already exists with different notes. Review it before replacing it.`)
  }
  // Validate every input before writing any mirrored file.
  writeFileSync(resolve(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n")
  writeFileSync(resolve(root, "src-tauri/Cargo.toml"), cargo)
  writeFileSync(resolve(root, "src-tauri/Cargo.lock"), cargoLock)
  mkdirSync(dirname(notesPath), { recursive: true })
  writeFileSync(notesPath, content)
  return version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Prepared Silo ${syncRelease()}. Review and commit the version files, changelog, release notes, and consumed changesets. Then run npm run release:draft.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

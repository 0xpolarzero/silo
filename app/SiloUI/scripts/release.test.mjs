import test from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { syncRelease } from "./sync-release.mjs"
import { release } from "./release.mjs"

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const metadata = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]
const read = path => readFileSync(path, "utf8")
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "silo-release-test-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const root = join(repo, "app/SiloUI")
  for (const file of [...metadata, ".changeset/config.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(source, file), join(root, file))
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
  writeFileSync(join(repo, ".gitignore"), "node_modules\n")
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" })
  git(["init", "-b", "main"])
  // Changesets creates annotated tags, which need identity beyond a single commit.
  git(["config", "user.name", "Release Test"])
  git(["config", "user.email", "release-test@example.invalid"])
  git(["config", "commit.gpgsign", "false"])
  git(["config", "tag.gpgsign", "false"])
  git(["add", "."])
  git(["commit", "-m", "Fixture"])
  return root
}
function prepare(root) {
  const pkg = JSON.parse(read(join(root, "package.json")))
  pkg.version = "9.8.7"
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
  writeFileSync(join(root, "CHANGELOG.md"), "# silo-ui\n\n## 9.8.7\n\n### Patch Changes\n\n- Clear release notes.\n\n## 0.1.0\n\nOlder notes.\n")
}
const snapshot = root => Object.fromEntries(metadata.map(file => [file, read(join(root, file))]))

test("real Changesets versions a private app, consumes notes, and syncs desktop metadata without changing dependencies", t => {
  const root = fixture(t)
  const before = snapshot(root)
  const oldVersion = JSON.parse(before["package.json"]).version
  const expected = oldVersion.replace(/\d+$/, patch => String(Number(patch) + 1))
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "add", "--patch", "silo-ui", "--message", "Make release preparation predictable."], { cwd: root, stdio: "pipe" })
  const pending = readdirSync(join(root, ".changeset")).filter(name => name.endsWith(".md") && name !== "README.md")
  assert.equal(pending.length, 1)
  const note = join(root, ".changeset", pending[0])
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "version"], { cwd: root, stdio: "pipe" })
  assert.equal(existsSync(note), false)
  assert.equal(syncRelease(root), expected)
  const after = snapshot(root)
  assert.equal(JSON.parse(after["package.json"]).version, expected)
  const lock = JSON.parse(after["package-lock.json"])
  assert.equal(lock.version, expected)
  assert.equal(lock.packages[""].version, expected)
  const originalLock = JSON.parse(before["package-lock.json"])
  for (const [name, entry] of Object.entries(originalLock.packages)) {
    if (name !== "") assert.deepEqual(lock.packages[name], entry)
  }
  for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    assert.equal(after[file], before[file].replace(`name = "silo-ui"\nversion = "${oldVersion}"`, `name = "silo-ui"\nversion = "${expected}"`))
  }
  const notes = read(resolve(root, "../../docs/releases", `${expected}.md`))
  assert.match(notes, /Make release preparation predictable\./)
  assert.ok(notes.startsWith(`# Silo ${expected}\n`))
  syncRelease(root)
  assert.deepEqual(snapshot(root), after)
  assert.equal(read(resolve(root, "../../docs/releases", `${expected}.md`)), notes)
  const changelog = read(join(root, "CHANGELOG.md"))
  assert.throws(() => execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "version"], { cwd: root, stdio: "pipe" }))
  assert.deepEqual(snapshot(root), after)
  assert.equal(read(join(root, "CHANGELOG.md")), changelog)
  assert.equal(read(resolve(root, "../../docs/releases", `${expected}.md`)), notes)
  execFileSync("git", ["add", "."], { cwd: resolve(root, "../.."), stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Prepare release"], { cwd: resolve(root, "../.."), stdio: "pipe" })
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "git-tag"], { cwd: root, stdio: "pipe" })
  assert.equal(execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" }).trim(), `v${expected}`)
})

for (const [name, mutate, error] of [
  ["invalid stable version", root => { const pkg = JSON.parse(read(join(root, "package.json"))); pkg.version = "9.8.7-beta.1"; writeFileSync(join(root, "package.json"), JSON.stringify(pkg)) }, /stable version/],
  ["missing changelog version", root => writeFileSync(join(root, "CHANGELOG.md"), "## 0.1.0\n\nOld notes.\n"), /No changelog/],
  ["empty notes", root => writeFileSync(join(root, "CHANGELOG.md"), "## 9.8.7\n\n"), /empty/],
  ["malformed Rust metadata", root => writeFileSync(join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "other"\nversion = "1.0.0"\n'), /exactly one/],
  ["malformed npm lock", root => writeFileSync(join(root, "package-lock.json"), "{}"), /lockfile/],
  ["conflicting existing notes", root => { const path = resolve(root, "../../docs/releases/9.8.7.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "Reviewed notes\n") }, /different notes/],
]) {
  test(`sync rejects ${name} before writing any metadata`, t => {
    const root = fixture(t)
    prepare(root)
    mutate(root)
    const before = snapshot(root)
    assert.throws(() => syncRelease(root), error)
    assert.deepEqual(snapshot(root), before)
    const notes = resolve(root, "../../docs/releases/9.8.7.md")
    if (existsSync(notes)) assert.equal(read(notes), "Reviewed notes\n")
  })
}

function runner(overrides = {}) {
  const calls = []
  const outputs = {
    "git status --porcelain": "",
    "python3 scripts/validate-release-version.py": "9.8.7",
    "git rev-parse HEAD": "head-commit",
    "git tag --list v9.8.7": "",
    "git rev-parse v9.8.7^{commit}": "head-commit",
    "git push origin refs/tags/v9.8.7": "",
    "git ls-remote origin refs/tags/v9.8.7 refs/tags/v9.8.7^{}": "tag-object\trefs/tags/v9.8.7\nhead-commit\trefs/tags/v9.8.7^{}",
    "gh workflow run publish-release.yml --ref v9.8.7 -f version=9.8.7": "",
    ...overrides,
  }
  return { calls, run(command, args) {
    calls.push([command, args])
    if (command === process.execPath && args[1] === "git-tag") return ""
    const key = [command, ...args].join(" ")
    assert.ok(Object.hasOwn(outputs, key), `Unexpected command: ${key}`)
    return outputs[key]
  } }
}
function ready(t) { const root = fixture(t); prepare(root); syncRelease(root); return root }

test("draft uses Changesets to tag and pushes only the exact release tag", t => {
  const root = ready(t)
  const fake = runner()
  release("draft", root, fake.run)
  assert.deepEqual(fake.calls.filter(([command]) => command === process.execPath), [[process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "git-tag"]]])
  assert.deepEqual(fake.calls.filter(([, args]) => args[0] === "push"), [["git", ["push", "origin", "refs/tags/v9.8.7"]]])
})

test("draft retries an existing matching tag without retagging", t => {
  const root = ready(t)
  const fake = runner({ "git tag --list v9.8.7": "v9.8.7" })
  release("draft", root, fake.run)
  assert.equal(fake.calls.some(([command]) => command === process.execPath), false)
})

test("publish verifies the peeled remote tag and explicitly dispatches the existing workflow", t => {
  const root = ready(t)
  const fake = runner()
  release("publish", root, fake.run)
  assert.deepEqual(fake.calls.at(-1), ["gh", ["workflow", "run", "publish-release.yml", "--ref", "v9.8.7", "-f", "version=9.8.7"]])
  assert.equal(fake.calls.some(([, args]) => args[0] === "push"), false)
})

for (const [name, action, overrides, mutate, error] of [
  ["dirty checkout", "draft", { "git status --porcelain": " M package.json" }, () => {}, /Commit or stash/],
  ["pending changeset", "draft", {}, root => writeFileSync(join(root, ".changeset/pending.md"), "pending"), /Unreleased changesets/],
  ["missing release notes", "draft", {}, root => rmSync(resolve(root, "../../docs/releases/9.8.7.md")), /Missing release notes/],
  ["mismatched local tag", "draft", { "git tag --list v9.8.7": "v9.8.7", "git rev-parse v9.8.7^{commit}": "old-commit" }, () => {}, /different commit/],
  ["incorrect generated tag", "draft", { "git rev-parse v9.8.7^{commit}": "old-commit" }, () => {}, /does not identify/],
  ["mismatched remote tag", "publish", { "git ls-remote origin refs/tags/v9.8.7 refs/tags/v9.8.7^{}": "old-commit\trefs/tags/v9.8.7" }, () => {}, /remote.*does not identify/],
]) {
  test(`release rejects ${name} without pushing or dispatching`, t => {
    const root = ready(t)
    mutate(root)
    const fake = runner(overrides)
    assert.throws(() => release(action, root, fake.run), error)
    assert.equal(fake.calls.some(([command, args]) => command === "gh" || args[0] === "push"), false)
  })
}

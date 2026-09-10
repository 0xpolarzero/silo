import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function release(action, root = app, run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }).trim()) {
  if (!["draft", "publish"].includes(action)) throw new Error("Use npm run release:draft or npm run release:publish.")
  if (run("git", ["status", "--porcelain"])) throw new Error("Commit or stash your changes before releasing. No tag was pushed.")
  const version = run("python3", ["scripts/validate-release-version.py"])
  const tag = `v${version}`
  const pending = readdirSync(resolve(root, ".changeset")).filter(name => name.endsWith(".md") && name !== "README.md")
  if (pending.length) throw new Error("Unreleased changesets remain. Run npm run release:version, review, and commit first.")
  const notes = resolve(root, "../../docs/releases", `${version}.md`)
  if (!existsSync(notes) || !readFileSync(notes, "utf8").trim()) throw new Error(`Missing release notes for ${version}. Run npm run release:version first.`)
  const head = run("git", ["rev-parse", "HEAD"])
  const localTag = run("git", ["tag", "--list", tag])
  if (localTag && run("git", ["rev-parse", `${tag}^{commit}`]) !== head) throw new Error(`${tag} belongs to a different commit. Check out that release or prepare a newer version.`)

  if (action === "draft") {
    // The library creates the tag; push only this version, never unrelated local tags.
    if (!localTag) run(process.execPath, [resolve(root, "node_modules/@changesets/cli/bin.js"), "git-tag"])
    if (run("git", ["rev-parse", `${tag}^{commit}`]) !== head) throw new Error(`${tag} does not identify this commit.`)
    run("git", ["push", "origin", `refs/tags/${tag}`])
    console.log(`Pushed ${tag}. GitHub Actions builds a signed draft; approve release-signing if requested. A repeated push does not restart a build. To retry, run Build Silo release on ${tag} with draft enabled.`)
  } else {
    // Dispatch against the immutable remote tag, not an unpushed local checkout.
    const remote = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split("\n")
    const peeled = remote.find(line => line.endsWith(`refs/tags/${tag}^{}`)) ?? remote.find(line => line.endsWith(`refs/tags/${tag}`))
    if (peeled?.split(/\s+/)[0] !== head) throw new Error(`The remote ${tag} does not identify this commit. Publish from the tagged release checkout.`)
    run("gh", ["workflow", "run", "publish-release.yml", "--ref", tag, "-f", `version=${version}`])
    console.log(`Requested verified publication of ${tag}. Approve release-publish if requested; publication is complete only when the workflow succeeds.`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { release(process.argv[2]) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

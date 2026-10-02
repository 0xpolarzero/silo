import test from "node:test"
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const runtimeModule = new URL("./microsandbox-runtime.mjs", import.meta.url).href
const toolScript = `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
const args = process.argv.slice(2)
if (process.argv[1].endsWith("rustc")) {
  console.log("rustc 1.94.0 (fixture)")
} else if (args.includes("fetch")) {
  if (process.env.FIXTURE_ROLE === "failure") throw new Error("Fixture compiler failure")
  if (process.env.FIXTURE_ROLE === "first") {
    writeFileSync(join(process.env.FIXTURE_ROOT, "ready"), process.cwd())
    const deadline = Date.now() + 10000
    while (true) {
      try { readFileSync(join(process.env.FIXTURE_ROOT, "continue")); break } catch {}
      if (Date.now() > deadline) throw new Error("Fixture gate timed out")
      await delay(10)
    }
  }
  if (readFileSync("source.txt", "utf8") !== "fixture source") throw new Error("Source was replaced")
} else {
  const target = args[args.indexOf("--target") + 1]
  const output = join(process.env.CARGO_TARGET_DIR, target, "release")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "msb"), ${JSON.stringify(`#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === "--version") console.log("msb 0.7.6")
else if (args[0].startsWith("--silo-")) console.log("1")
else console.log("--authorized-keys --exit-on-stdin-close --expected-machine-id --stage-id")
`)}, { mode: 0o755 })
}
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "silo-runtime-concurrency-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  const source = join(root, "source")
  await mkdir(bin)
  await mkdir(source)
  await writeFile(join(source, "source.txt"), "fixture source")
  const archive = join(root, "source.tar.gz")
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", root, "source"])
  for (const tool of ["rustc", "cargo"]) await writeFile(join(bin, tool), toolScript, { mode: 0o755 })
  const worker = join(root, "worker.mjs")
  await writeFile(worker, `
import { buildPatchedExecutable } from ${JSON.stringify(runtimeModule)}
const bytes = await buildPatchedExecutable({
  targetTriple: "aarch64-apple-darwin", hostTriple: "aarch64-apple-darwin",
  sourceArchive: ${JSON.stringify(archive)}, patches: [],
  agentd: Buffer.from("fixture agent"), cacheRoot: ${JSON.stringify(join(root, "cache"))},
})
if (!bytes.length) throw new Error("No executable returned")
`)
  return { root, bin, worker }
}

function runWorker(t, fixture, role) {
  const child = spawn(process.execPath, [fixture.worker], {
    env: { ...process.env, PATH: fixture.bin, HOME: fixture.root, FIXTURE_ROOT: fixture.root, FIXTURE_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM") })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk })
  child.stderr.on("data", chunk => { output += chunk })
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", code => resolve({ code, output }))
  })
}

async function waitForFile(path) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8") } catch { await delay(10) }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

test("a completed preparation cannot remove another process's active source", { timeout: 15000 }, async t => {
  const paths = await fixture(t)
  const first = runWorker(t, paths, "first")
  const firstSource = await waitForFile(join(paths.root, "ready"))
  try {
    const second = await runWorker(t, paths, "second")
    assert.equal(second.code, 0, second.output)
    assert.equal(await readFile(join(firstSource, "source.txt"), "utf8"), "fixture source")
  } finally {
    await writeFile(join(paths.root, "continue"), "continue")
  }
  const result = await first
  assert.equal(result.code, 0, result.output)
  await assert.rejects(readFile(join(firstSource, "source.txt")), { code: "ENOENT" })
})


test("a failed preparation removes its own extracted source", async t => {
  const paths = await fixture(t)
  const result = await runWorker(t, paths, "failure")
  assert.notEqual(result.code, 0)
  assert.match(result.output, /Fixture compiler failure/)
  const builds = join(paths.root, "cache", "patched-builds")
  for (const name of await readdir(builds)) {
    assert.deepEqual((await readdir(join(builds, name))).filter(entry => entry.startsWith("work-")), [])
  }
})

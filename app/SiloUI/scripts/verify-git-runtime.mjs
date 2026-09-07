import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = resolve(process.argv[2] ?? join(appRoot, "src-tauri/runtime/git"))
const manifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8"))
const executableRoot = process.argv[3] ? resolve(process.argv[3]) : undefined
const packaged = manifest.paths.packagedExecutables
const gitPath = executableRoot ? join(executableRoot, packaged.git) : join(runtimeRoot, manifest.paths.git)
const gitLfsPath = executableRoot ? join(executableRoot, packaged.gitLfs) : join(runtimeRoot, manifest.paths.gitLfs)
const gitRemoteHttpPath = executableRoot
  ? join(executableRoot, packaged.gitRemoteHttp)
  : join(runtimeRoot, manifest.paths.gitExecPath, "git-remote-http")
const gitRemoteHttpsPath = executableRoot
  ? join(executableRoot, packaged.gitRemoteHttps)
  : join(runtimeRoot, manifest.paths.gitExecPath, "git-remote-https")
const execPath = executableRoot ?? join(runtimeRoot, manifest.paths.gitExecPath)
const testRoot = await mkdtemp(join(tmpdir(), "silo-bundled-git-"))
const home = join(testRoot, "home")
const hostHome = join(testRoot, "host-home")
const configHome = join(testRoot, "config")
const work = join(testRoot, "work")
const remote = join(testRoot, "remote.git")
const utilities = join(testRoot, "utilities")
await mkdir(home)
await mkdir(hostHome)
await mkdir(configHome)
await mkdir(utilities)
await symlink("/bin/sh", join(utilities, "sh"))
await writeFile(join(hostHome, ".gitconfig"), "[invalid host configuration that must stay unread\n")

const environment = {
  HOME: home,
  XDG_CONFIG_HOME: configHome,
  PATH: `${join(runtimeRoot, "bin")}:${execPath}:${utilities}`,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_EXEC_PATH: execPath,
  GIT_TEMPLATE_DIR: join(runtimeRoot, manifest.paths.templates),
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  TMPDIR: testRoot,
}
if (manifest.paths.certificateBundle) {
  environment.GIT_SSL_CAINFO = join(runtimeRoot, manifest.paths.certificateBundle)
}

function runGit(args, cwd = testRoot) {
  return run(gitPath, args, cwd)
}

function run(command, args, cwd = testRoot) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim()
}

function signatureDetails(path) {
  const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path], {
    encoding: "utf8",
  })
  if (verified.status !== 0) {
    throw new Error(`Invalid code signature for ${path}: ${(verified.stderr || verified.stdout).trim()}`)
  }
  const displayed = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", path], { encoding: "utf8" })
  if (displayed.status !== 0) throw new Error(`Cannot inspect code signature for ${path}`)
  const details = `${displayed.stdout}${displayed.stderr}`
  if (!/flags=.*\bruntime\b/.test(details)) {
    throw new Error(`Hardened runtime is missing from ${path}`)
  }
  return details
}

async function verifyPackagedMacSignatures() {
  if (process.platform !== "darwin" || !executableRoot) return "not-applicable"
  const appBundle = dirname(dirname(executableRoot))
  const appDetails = signatureDetails(appBundle)
  const expectedTeam = appDetails.match(/^TeamIdentifier=(.+)$/m)?.[1]
  for (const executable of [gitPath, gitLfsPath, gitRemoteHttpPath, gitRemoteHttpsPath]) {
    if ((await lstat(executable)).isSymbolicLink()) {
      const target = await realpath(executable)
      const nested = relative(executableRoot, target)
      if (nested === ".." || nested.startsWith(`..${sep}`) || nested.startsWith(sep)) {
        throw new Error(`Packaged helper link escapes its executable directory: ${executable}`)
      }
    }
    const details = signatureDetails(executable)
    const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]
    if (team !== expectedTeam) {
      throw new Error(`Packaged helper was not signed with the app identity: ${executable}`)
    }
  }
  return expectedTeam ?? "not set (ad hoc)"
}

function verifyHttpsHelperLoads() {
  const result = spawnSync(gitRemoteHttpsPath, [], { encoding: "utf8", env: environment, timeout: 30_000 })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.error) throw result.error
  if (result.status !== 1 || !output.includes("usage: git remote-curl")) {
    throw new Error(`Bundled HTTPS helper did not reach its usage path: ${output.trim()}`)
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

try {
  const signingTeam = await verifyPackagedMacSignatures()
  const gitVersion = runGit(["--version"])
  if (gitVersion !== manifest.gitVersionOutput) {
    throw new Error(`Unexpected Git version: ${gitVersion}`)
  }
  const lfsVersion = run(gitLfsPath, ["version"])
  if (!lfsVersion.startsWith(`git-lfs/${manifest.gitLfsVersion} `)) {
    throw new Error(`Unexpected Git LFS version: ${lfsVersion}`)
  }
  if (runGit(["lfs", "version"]) !== lfsVersion) throw new Error("Git did not resolve its private Git LFS helper")
  if (runGit(["--exec-path"]) !== execPath) throw new Error("Git did not use its private helper directory")
  if (runGit(["config", "--global", "--list"]) !== "") throw new Error("Git read a global configuration")
  verifyHttpsHelperLoads()

  runGit(["init", "--bare", "--initial-branch=main", remote])
  runGit(["init", "--initial-branch=main", work])
  runGit(["lfs", "install", "--local"], work)
  const payload = "bundled-lfs-payload\n"
  await writeFile(join(work, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
  await writeFile(join(work, "payload.bin"), payload)
  runGit(["add", "."], work)
  runGit(["-c", "user.name=Silo", "-c", "user.email=silo.invalid", "commit", "-m", "test"], work)
  runGit(["remote", "add", "origin", remote], work)
  const privateReceivePack = `${shellQuote(gitPath)} receive-pack`
  runGit(["push", `--receive-pack=${privateReceivePack}`, "origin", "main"], work)
  const firstRemoteHead = runGit([`--git-dir=${remote}`, "rev-parse", "refs/heads/main"])
  runGit(["push", `--receive-pack=${privateReceivePack}`, "origin", "main"], work)
  const secondRemoteHead = runGit([`--git-dir=${remote}`, "rev-parse", "refs/heads/main"])
  if (secondRemoteHead !== firstRemoteHead) throw new Error("Unchanged second push moved the remote ref")

  const pointer = runGit(["show", "HEAD:payload.bin"], work)
  if (!pointer.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
    throw new Error("Git LFS clean filter did not write a pointer")
  }
  const objectId = createHash("sha256").update(payload).digest("hex")
  const transferredObject = join(remote, "lfs", "objects", objectId.slice(0, 2), objectId.slice(2, 4), objectId)
  if (!existsSync(transferredObject)) throw new Error("Git LFS did not transfer the object to the local remote")

  console.log(JSON.stringify({
    gitVersion,
    lfsVersion,
    execPath,
    signingTeam,
    httpsHelperLoad: "passed",
    localGitPush: "passed",
    localLfsTransfer: "passed",
    unchangedSecondPush: "passed",
  }))
} finally {
  await rm(testRoot, { recursive: true, force: true })
}

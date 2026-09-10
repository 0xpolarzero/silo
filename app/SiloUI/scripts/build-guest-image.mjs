import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { createGzip } from "node:zlib"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const architecture = process.argv[2]
if (!["arm64", "amd64"].includes(architecture)) throw new Error("Usage: node scripts/build-guest-image.mjs arm64|amd64")
const version = "ubuntu-24.04-v1"
const imageReference = `ghcr.io/0xpolarzero/silo-guest:${version}-${architecture}`
const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
const output = resolve(root, "src-tauri/guest-image-artifacts", architecture)
await mkdir(output, { recursive: true })
execFileSync("docker", ["build", "--label", `org.opencontainers.image.revision=${revision}`, "--platform", `linux/${architecture}`, "-f", resolve(root, "guest-image/Dockerfile"), "-t", imageReference, root], { stdio: "inherit" })
const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageReference], { encoding: "utf8" }))[0]
execFileSync("docker", ["run", "--rm", "--network", "none", "--platform", `linux/${architecture}`, imageReference, "sh", "-ec", "git --version; git lfs version; gh --version; test -x /usr/local/libexec/silo-github-credential"], { stdio: "inherit" })
const packages = execFileSync("docker", ["run", "--rm", "--network", "none", "--platform", `linux/${architecture}`, imageReference, "cat", "/usr/local/share/silo-packages.txt"], { encoding: "utf8" })
const archive = resolve(output, "image.tar.gz")
let unpackedBytes = 0
const save = spawn("docker", ["image", "save", imageReference], { stdio: ["ignore", "pipe", "inherit"] })
const exited = new Promise((resolve, reject) => { save.on("error", reject); save.on("exit", code => code === 0 ? resolve() : reject(new Error(`docker save exited ${code}`))) })
save.stdout.on("data", chunk => { unpackedBytes += chunk.length })
await Promise.all([pipeline(save.stdout, createGzip({ level: 9 }), createWriteStream(archive)), exited])
const hash = createHash("sha256")
for await (const chunk of createReadStream(archive)) hash.update(chunk)
const manifest = { schemaVersion: 1, version, ubuntuVersion: "24.04", architecture: architecture === "arm64" ? "aarch64" : "x86_64", imageReference, imageDigest: image.Id, archiveSha256: hash.digest("hex"), archiveBytes: (await stat(archive)).size, unpackedBytes, baseImage: "ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254", packages: Object.fromEntries(packages.trim().split("\n").map(line => line.split("\t"))) }
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Built ${imageReference}: ${manifest.archiveBytes} compressed bytes, config ${manifest.imageDigest}`)

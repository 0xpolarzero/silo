import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, readFileSync } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { createGzip } from "node:zlib"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export function verifyGuestImage(architecture, imageReference, { run = execFileSync } = {}) {
  if (!["arm64", "amd64"].includes(architecture)) throw new Error("Unsupported guest image architecture")
  const tools = readFileSync(resolve(root, "src-tauri/guest/verify-tools.sh"), "utf8")
  const check = `${tools}
curl --version
curl -fsS file:///etc/os-release -o /dev/null
command -v sudo >/dev/null || { echo "Guest image is missing sudo" >&2; exit 1; }
python3 -c 'import json; assert json.loads("true") is True'
test -x /usr/lib/openssh/sftp-server
if getent passwd silo || getent group silo; then
  echo "The working account must be provisioned per VM, not preinstalled in the image" >&2
  exit 1
fi
sudo -n -u nobody sh -ec 'test "$(id -u)" != 0; /usr/lib/openssh/sftp-server -Q requests >/dev/null'
`
  run("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--platform", `linux/${architecture}`, imageReference, "sh", "-ec", check], { stdio: "inherit" })
}

export async function buildGuestImage(architecture) {
  if (!["arm64", "amd64"].includes(architecture)) throw new Error("Usage: node scripts/build-guest-image.mjs arm64|amd64")
  const version = "ubuntu-24.04-v3"
  const imageReference = `ghcr.io/0xpolarzero/silo-guest:${version}-${architecture}`
  const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  const output = resolve(root, "src-tauri/guest-image-artifacts", architecture)
  await mkdir(output, { recursive: true })
  execFileSync("docker", ["build", "--label", `org.opencontainers.image.revision=${revision}`, "--platform", `linux/${architecture}`, "-f", resolve(root, "guest-image/Dockerfile"), "-t", imageReference, root], { stdio: "inherit" })
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageReference], { encoding: "utf8" }))[0]
  verifyGuestImage(architecture, imageReference)
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildGuestImage(process.argv[2])
}

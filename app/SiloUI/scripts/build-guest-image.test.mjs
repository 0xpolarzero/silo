import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import test from "node:test"
import { GUEST_IMAGE_VERSION, guestImageMetadata, lcuArchive, verifyGuestImage } from "./build-guest-image.mjs"

for (const saveExit of [1, 0]) {
  test(`guest archive publication preserves complete outputs when docker save exits ${saveExit}`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "silo-guest-save-")))
    t.after(() => rm(root, { recursive: true, force: true }))
    const scripts = join(root, "scripts")
    const guest = join(root, "src-tauri/guest")
    const output = join(root, "src-tauri/guest-image-artifacts/arm64")
    const commands = join(root, "commands")
    for (const directory of [scripts, guest, output, commands]) await mkdir(directory, { recursive: true })
    const script = join(scripts, "build-guest-image.mjs")
    await writeFile(script, await readFile(new URL("./build-guest-image.mjs", import.meta.url)))
    await writeFile(join(guest, "lcu-lock.json"), await readFile(new URL("../src-tauri/guest/lcu-lock.json", import.meta.url)))
    await writeFile(join(guest, "verify-tools.sh"), "true\n")
    await writeFile(join(root, "package.json"), '{"repository":{"url":"https://github.com/fixture/silo"}}')
    await writeFile(join(output, "image.tar.gz"), "previous verified archive")
    await writeFile(join(output, "manifest.json"), "previous manifest")
    const docker = `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === 'image' && args[1] === 'inspect') console.log(JSON.stringify([{ Id: 'sha256:fixture' }]))
if (args[0] === 'run' && args.at(-1) === '/usr/local/share/silo-packages.txt') console.log('fixture-package\\t1')
if (args[0] === 'image' && args[1] === 'save') {
  process.stdout.write('saved image fixture', () => process.exit(${saveExit}))
}
`
    await writeFile(join(commands, "docker"), docker, { mode: 0o755 })
    const result = spawnSync(process.execPath, [script, "arm64"], { encoding: "utf8", env: {
      ...process.env, PATH: `${commands}:${dirname(process.execPath)}`, GITHUB_REPOSITORY: "fixture/silo", GITHUB_SHA: "fixture",
    } })
    assert.equal(result.status, saveExit, result.stderr)
    if (saveExit) {
      assert.equal(await readFile(join(output, "image.tar.gz"), "utf8"), "previous verified archive")
      assert.equal(await readFile(join(output, "manifest.json"), "utf8"), "previous manifest")
    } else {
      const archive = await readFile(join(output, "image.tar.gz"))
      assert.equal(gunzipSync(archive).toString(), "saved image fixture")
      const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"))
      assert.equal(manifest.archiveSha256, createHash("sha256").update(archive).digest("hex"))
      assert.equal(manifest.archiveBytes, archive.length)
      assert.equal(manifest.unpackedBytes, Buffer.byteLength("saved image fixture"))
      assert.equal(manifest.architecture, "aarch64")
      assert.deepEqual(manifest.packages, { "fixture-package": "1" })
    }
    assert.deepEqual((await readdir(output)).sort(), ["image.tar.gz", "manifest.json"])
  })
}

test("publication names derive from the recipe version and the publishing repository", () => {
  assert.deepEqual(guestImageMetadata({ GITHUB_REPOSITORY: "Example-Owner/silo" }), {
    version: GUEST_IMAGE_VERSION,
    image: `ghcr.io/example-owner/silo-guest:${GUEST_IMAGE_VERSION}`,
    tag: `guest-${GUEST_IMAGE_VERSION}`,
    title: `Silo guest ${GUEST_IMAGE_VERSION.replace(/^ubuntu-([\d.]+)-(v\d+)$/, "Ubuntu $1 $2")}`,
  })
  // Local builds fall back to the package's repository.
  assert.match(guestImageMetadata({}).image, /^ghcr\.io\/[a-z0-9-]+\/silo-guest:/)
})

test("the publication workflow repeats neither the image version nor the owner", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/guest-image.yml", import.meta.url), "utf8")
  assert.equal(workflow.includes(GUEST_IMAGE_VERSION), false)
  assert.doesNotMatch(workflow, /ghcr\.io\/[a-z0-9]/)
  assert.match(workflow, /environment: guest-image-publish/)
})

test("the recipe matches the version and never leaves package files in a layer", () => {
  const dockerfile = readFileSync(new URL("../guest-image/Dockerfile", import.meta.url), "utf8")
  assert.ok(dockerfile.includes(`org.opencontainers.image.version="${GUEST_IMAGE_VERSION}"`))
  // Package files are downloaded, verified and deleted in one RUN, or bind-mounted; never COPYed.
  assert.doesNotMatch(dockerfile, /^COPY .*\.deb/m)
  assert.match(dockerfile, /RUN --mount=type=bind,source=src-tauri\/guest\/desktop-streamer-lock\.json/)
  assert.match(dockerfile, /sha256sum --check/)
  assert.doesNotMatch(dockerfile.replace(/^#.*$/gm, ""), /mousepad/)
  assert.match(dockerfile, /gnome-text-editor/)
  // The runtime installer detects v4 by this marker; it must match the recipe version.
  assert.ok(dockerfile.includes(`"version":"${GUEST_IMAGE_VERSION}"`))
  assert.match(dockerfile, /"capabilities":\["desktop","accessibility"/)
  assert.ok(dockerfile.includes("/usr/local/share/silo/guest-image.json"))
  assert.doesNotMatch(dockerfile.replace(/^#.*$/gm, ""), /openai|oaistatic|chatgpt/i)
  const ignore = readFileSync(new URL("../guest-image/Dockerfile.dockerignore", import.meta.url), "utf8")
  for (const input of ["desktop-streamer-lock.json", "desktop-packages.txt", "silo-accessibility.py", "setup-github.sh", "guest-third-party-notices.md"]) {
    assert.ok(ignore.includes(`!src-tauri/guest/${input}`), input)
  }
})

test("the image ships the third-party notices that THIRD-PARTY-NOTICES.md repeats", () => {
  const dockerfile = readFileSync(new URL("../guest-image/Dockerfile", import.meta.url), "utf8")
  assert.match(dockerfile, /source=src-tauri\/guest\/guest-third-party-notices\.md,target=\/mnt\/guest-third-party-notices\.md/)
  assert.ok(dockerfile.includes("/mnt/guest-third-party-notices.md /usr/share/doc/silo-guest-third-party/NOTICES.md"))
  const notices = readFileSync(new URL("../src-tauri/guest/guest-third-party-notices.md", import.meta.url), "utf8")
  const bundled = readFileSync(new URL("../THIRD-PARTY-NOTICES.md", import.meta.url), "utf8")
  assert.ok(bundled.includes(notices.trim()), "THIRD-PARTY-NOTICES.md must contain the guest notices verbatim")
  for (const required of ["x264", "x265", "n8.1", "guest-ubuntu-24.04-v4-source", "written offer"]) {
    assert.ok(notices.toLowerCase().includes(required.toLowerCase()), required)
  }
})

test("the release attaches every guest input the image build consumes", () => {
  const dockerfile = readFileSync(new URL("../guest-image/Dockerfile", import.meta.url), "utf8")
  const workflow = readFileSync(new URL("../../../.github/workflows/guest-image.yml", import.meta.url), "utf8")
  const inputs = new Set([...dockerfile.replace(/^#.*$/gm, "").matchAll(/source=src-tauri\/guest\/([A-Za-z0-9._-]+)/g)].map((match) => match[1]))
  assert.ok(inputs.has("lcu-lock.json"))
  for (const input of inputs) {
    assert.ok(workflow.includes(`cp app/SiloUI/src-tauri/guest/${input} guest-release/${input}`), input)
  }
})

test("the pinned LCU archive is staged from one lock, hash-checked, and never installed in the image", () => {
  const dockerfile = readFileSync(new URL("../guest-image/Dockerfile", import.meta.url), "utf8")
  const code = dockerfile.replace(/^#.*$/gm, "")
  assert.doesNotMatch(dockerfile, /TODO\(LCU\)/)
  assert.match(code, /source=src-tauri\/guest\/lcu-lock\.json,target=\/mnt\/lcu-lock\.json/)
  assert.match(code, /echo "\$lcu_sha256  \$lcu_archive" \| sha256sum --check --status/)
  assert.ok(code.includes("/usr/local/share/silo/lcu"))
  assert.match(code, /"capabilities":\["desktop","accessibility","lcu-system-packages","lcu-archive"\]/)
  // The archive is staged, not extracted or installed; the lock is read, never copied into a layer.
  assert.doesNotMatch(code, /install\.sh|tar -x|COPY .*lcu/)
  const ignore = readFileSync(new URL("../guest-image/Dockerfile.dockerignore", import.meta.url), "utf8")
  assert.ok(ignore.includes("!src-tauri/guest/lcu-lock.json"))
  // One edit bumps LCU: the lock names both architectures, and the app lock agrees on the version.
  const lock = JSON.parse(readFileSync(new URL("../src-tauri/guest/lcu-lock.json", import.meta.url), "utf8"))
  const appLock = JSON.parse(readFileSync(new URL("../src-tauri/guest/chatgpt-app-lock.json", import.meta.url), "utf8"))
  assert.equal(appLock.lcuVersion, lock.version)
  assert.deepEqual(Object.keys(lock.assets).sort(), ["amd64", "arm64"])
  for (const architecture of ["arm64", "amd64"]) {
    const archive = lcuArchive(architecture)
    assert.equal(archive.version, lock.version)
    assert.match(archive.name, new RegExp(`^lcu-${lock.version.replaceAll(".", "\\.")}-linux-(arm64|x64)\\.tar\\.gz$`))
    assert.match(archive.sha256, /^[0-9a-f]{64}$/)
  }
  assert.throws(() => lcuArchive("riscv64"), /LCU lock/)
})

test("offline image validation rejects unsupported platforms before invoking Docker", () => {
  assert.throws(() => verifyGuestImage("riscv64", "unused", {
    run: () => assert.fail("Unsupported image must not run"),
  }), /architecture/)
})

test("offline validation forbids image pulls and preserves tool-check failures", () => {
  const failedCheck = new Error("Guest tool check failed")
  assert.throws(() => verifyGuestImage("arm64", "local-fixture", {
    run(command, args) {
      assert.equal(command, "docker")
      assert.equal(args[0], "run")
      assert.equal(args[args.indexOf("--network") + 1], "none")
      assert.equal(args[args.indexOf("--pull") + 1], "never")
      assert.equal(args[args.indexOf("--platform") + 1], "linux/arm64")
      assert.ok(args.includes("--rm"))
      throw failedCheck
    },
  }), error => error === failedCheck)
})

// Runs only against an explicitly supplied, already-built image. Each failure
// fixture mutates its disposable container; neither the image nor host changes.
const image = process.env.SILO_TEST_GUEST_IMAGE
const architecture = process.env.SILO_TEST_GUEST_ARCHITECTURE || "arm64"
test("bundled guest tools and unprivileged SFTP work without network", { skip: !image }, () => {
  verifyGuestImage(architecture, image)
})
for (const [name, mutation] of [
  ["missing sudo", "rm -f /usr/bin/sudo"],
  ["missing Python", "rm -f /usr/bin/python3"],
  ["SFTP executable unavailable to normal users", "chmod 0700 /usr/lib/openssh/sftp-server"],
  ["preinstalled working account", "useradd --no-create-home silo"],
  ["missing dconf user profile", "rm -f /etc/dconf/profile/user"],
  ["invalid accessibility poller", "echo 'def (' > /usr/local/libexec/silo-accessibility"],
  ["autostart entry naming a missing program", "sed -i 's#^Exec=.*#Exec=/usr/local/libexec/missing#' /etc/xdg/autostart/silo-accessibility.desktop"],
  ["leftover package file", "touch /var/cache/selkies.deb"],
  ["tampered staged LCU archive", "echo x >> /usr/local/share/silo/lcu/*.tar.gz"],
  ["LCU installed in the image", "mkdir -p /opt/lcu"],
]) {
  test(`offline image check rejects ${name}`, { skip: !image }, () => {
    assert.throws(() => verifyGuestImage(architecture, image, {
      run(command, args) {
        const mutated = [...args]
        mutated[mutated.length - 1] = `${mutation}\n${mutated.at(-1)}`
        execFileSync(command, mutated, { stdio: "pipe" })
      },
    }))
  })
}

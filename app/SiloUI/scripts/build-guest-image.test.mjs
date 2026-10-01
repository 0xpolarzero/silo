import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { GUEST_IMAGE_VERSION, guestImageMetadata, verifyGuestImage } from "./build-guest-image.mjs"

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
  for (const input of ["desktop-streamer-lock.json", "desktop-packages.txt", "silo-accessibility.py", "setup-github.sh"]) {
    assert.ok(ignore.includes(`!src-tauri/guest/${input}`), input)
  }
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

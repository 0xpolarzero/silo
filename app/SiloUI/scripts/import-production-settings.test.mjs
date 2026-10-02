import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  COPIED_SETTINGS, DEVELOPMENT, PRODUCTION, channelPaths, devProcessRunning, importProductionSettings, sanitizeSecrets, sanitizeSettings,
} from "./import-production-settings.mjs"

const VAULT = { "value-1": "s3cret-one", "value-2": "s3cret-two", orphan: "never-copied" }
const HOSTS = [{ id: "11111111-1111-4111-8111-111111111111", name: "Linux box", address: "me@10.0.0.2" }]

function memoryKeychain(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    writes: [],
    read(service, account) { return items.get(`${service}/${account}`) ?? null },
    write(service, account, value) { this.writes.push(`${service}/${account}`); items.set(`${service}/${account}`, value) },
  }
}

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "silo-import-"))
  const source = channelPaths(PRODUCTION, { home, platform: "darwin" })
  const put = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof contents === "string" || Buffer.isBuffer(contents) ? contents : `${JSON.stringify(contents)}\n`)
  }
  put(path.join(source.config, "settings.json"), {
    schemaVersion: 1,
    settings: { theme: "dark", onboardingComplete: true, notifyBackup: false, launchAtLogin: true, startWorkspacesAtLaunch: true, startupWorkspaceIds: ["x"], editor: "Zed", unknown: 1 },
    onboardingDraft: { step: 2 },
  })
  put(path.join(source.data, "secrets.json"), {
    pendingRevocations: [{ secretId: "a" }],
    secrets: [
      { id: "a", name: "API_KEY", valueId: "value-1", workspaces: ["dev", "other"], allowedDomains: ["example.com"], affected: ["dev"], pendingWorkspaces: ["dev"], errors: { dev: "x" }, removing: false },
      { id: "b", name: "OLD", valueId: "value-2", workspaces: [], allowedDomains: [], removing: true },
    ],
    activities: [{ id: 1 }],
  })
  put(path.join(source.data, "github.json"), { revision: 7, accessEnabled: true, account: "octo", workspaces: [{ name: "dev" }], repositories: [{}] })
  put(path.join(source.data, "update-preferences.json"), { automaticChecks: true })
  // Sandbox data that must never be copied.
  put(path.join(source.data, "machines.json"), { machines: ["dev"] })
  put(path.join(source.data, "microsandbox", "sandboxes", "dev", "disk.img"), "vm")
  put(path.join(source.data, "volumes", "dev", "file"), "data")
  put(path.join(source.data, "backup-history.json"), {})
  put(path.join(source.data, "network.json"), {})
  put(path.join(source.config, "ssh-access.json"), {})
  put(path.join(source.state, "abcdef123456", "run", "x"), "runtime alias")
  put(path.join(source.state, "editor", "silo-abc-dev", "w.code-workspace"), "{}")
  put(path.join(source.state, "desktop-remote", "config.json"), { hostId: "99999999-9999-4999-8999-999999999999", enabled: true, hosts: HOSTS })
  put(path.join(source.state, "desktop-remote", "id_ed25519"), "PRIVATE KEY")
  put(path.join(source.state, "desktop-remote", "id_ed25519.pub"), "ssh-ed25519 AAAA Silo remote management\n")
  put(path.join(source.state, "desktop-remote", "ssh", "host.key"), "derived")
  put(path.join(home, ".ssh", "config"), "Host prod\n")
  return { home, source, target: channelPaths(DEVELOPMENT, { home, platform: "darwin" }) }
}

function productionKeychain() {
  return memoryKeychain({
    [`${PRODUCTION.keychain.secrets}/values`]: JSON.stringify(VAULT),
    [`${PRODUCTION.keychain.github}/personal-token`]: JSON.stringify({ token: "ghp_abc", account: "octo" }),
    [`${PRODUCTION.keychain.github}/account`]: JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1 }),
    [`${PRODUCTION.keychain.github}/runtime-grants`]: "ledger",
  })
}

function snapshot(root) {
  const entries = []
  const walk = directory => {
    for (const name of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, name.name)
      if (name.isDirectory()) walk(file)
      else entries.push(`${path.relative(root, file)}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`)
    }
  }
  walk(root)
  return entries
}

function list(root) {
  const files = []
  const walk = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else files.push(path.relative(root, file))
    }
  }
  walk(root)
  return files.sort()
}

const run = (home, keychain, options = {}) => importProductionSettings({
  home, platform: "darwin", keychain, isDevRunning: () => false, newId: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ...options,
})

test("file sync failure preserves Dev settings and removes private staging files", async t => {
  const { home, source, target } = fixtureHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(target.config, { recursive: true })
  const settings = path.join(target.config, "settings.json")
  fs.writeFileSync(settings, "previous Dev settings")
  const before = snapshot(source.config)
  const keychain = productionKeychain()
  t.mock.method(fs, "fsyncSync", () => { throw new Error("file sync failed") })
  await assert.rejects(run(home, keychain, { yes: true }), /file sync failed/)
  assert.equal(fs.readFileSync(settings, "utf8"), "previous Dev settings")
  assert.deepEqual(fs.readdirSync(target.config), ["settings.json"])
  assert.deepEqual(snapshot(source.config), before)
  assert.deepEqual(keychain.writes, [])
})

test("interrupted import removes partially written private backup staging", async t => {
  const { home, target } = fixtureHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(target.config, { recursive: true })
  const settings = path.join(target.config, "settings.json")
  fs.writeFileSync(settings, "previous private Dev settings")
  const write = fs.writeFileSync
  t.mock.method(fs, "writeFileSync", (file, bytes, options) => {
    write(file, Buffer.from(bytes).subarray(0, 8), options)
    throw new Error("interrupted write")
  })
  await assert.rejects(run(home, productionKeychain(), { yes: true }), /interrupted write/)
  assert.equal(fs.readFileSync(settings, "utf8"), "previous private Dev settings")
  assert.deepEqual(fs.readdirSync(target.config), ["settings.json"])
})

test("import syncs final file permissions before rename and rejects directory sync failure", async t => {
  const { home, target } = fixtureHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const settings = path.join(target.config, "settings.json")
  const synced = []
  const fsync = fs.fsyncSync
  t.mock.method(fs, "fsyncSync", fd => {
    const info = fs.fstatSync(fd)
    if (info.isFile()) {
      assert.equal(fs.existsSync(settings), false)
      assert.equal(info.mode & 0o777, 0o600)
      assert.ok(info.size > 0)
      synced.push("file")
      fsync(fd)
    } else {
      assert.equal(info.isDirectory(), true)
      assert.equal(info.ino, fs.statSync(target.config).ino)
      assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).settings.theme, "dark")
      synced.push("directory")
      throw new Error("directory sync failed")
    }
  })
  await assert.rejects(run(home, productionKeychain()), /directory sync failed/)
  assert.deepEqual(synced, ["file", "directory"])
  assert.deepEqual(fs.readdirSync(target.config), ["settings.json"])
})

test("copies the intended configuration into dev and nothing about sandboxes", async () => {
  const { home, target } = fixtureHome()
  const keychain = productionKeychain()
  const result = await run(home, keychain)
  assert.equal(result.performed, true)

  const settings = JSON.parse(fs.readFileSync(path.join(target.config, "settings.json"), "utf8"))
  assert.deepEqual(settings.settings, { theme: "dark", onboardingComplete: true, notifyBackup: false, editor: "Zed" })
  assert.equal(settings.onboardingDraft, null)

  const secrets = JSON.parse(fs.readFileSync(path.join(target.data, "secrets.json"), "utf8"))
  assert.equal(secrets.secrets.length, 1)
  assert.deepEqual(secrets.secrets[0].workspaces, [])
  assert.deepEqual(secrets.secrets[0].affected, [])
  assert.deepEqual(secrets.secrets[0].errors, {})
  assert.deepEqual(secrets.pendingRevocations, [])
  assert.deepEqual(JSON.parse(keychain.read(DEVELOPMENT.keychain.secrets, "values")), { "value-1": "s3cret-one" })
  assert.equal(keychain.read(DEVELOPMENT.keychain.github, "personal-token"), keychain.read(PRODUCTION.keychain.github, "personal-token"))
  assert.equal(keychain.read(DEVELOPMENT.keychain.github, "account"), null, "OAuth login is opt-in")
  assert.equal(keychain.read(DEVELOPMENT.keychain.github, "runtime-grants"), null)

  const remote = JSON.parse(fs.readFileSync(path.join(target.state, "desktop-remote", "config.json"), "utf8"))
  assert.equal(remote.hostId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "dev gets its own identity")
  assert.notEqual(remote.hostId, "99999999-9999-4999-8999-999999999999")
  assert.equal(remote.enabled, false)
  assert.deepEqual(remote.hosts, HOSTS)
  assert.equal(fs.readFileSync(path.join(target.state, "desktop-remote", "id_ed25519"), "utf8"), "PRIVATE KEY")
  assert.equal(fs.statSync(path.join(target.state, "desktop-remote", "id_ed25519")).mode & 0o777, 0o600)

  // Exactly these files exist under the dev channel: no VM, sandbox, runtime or derived data.
  const all = [...list(target.config), ...list(target.data), ...list(target.state)].sort()
  assert.deepEqual([...new Set(all)].sort(), [
    "desktop-remote/config.json", "desktop-remote/id_ed25519", "desktop-remote/id_ed25519.pub", "secrets.json", "settings.json",
  ])
})

test("production files and keychain entries are never modified and only dev services are written", async () => {
  const { home, source } = fixtureHome()
  const keychain = productionKeychain()
  const beforeFiles = [...snapshot(source.config), ...snapshot(source.state), ...snapshot(path.join(home, ".ssh"))]
  const beforeKeychain = [...keychain.items].filter(([key]) => !key.includes(".dev.")).sort()
  await run(home, keychain, { includeGithubOauth: true })
  assert.deepEqual([...snapshot(source.config), ...snapshot(source.state), ...snapshot(path.join(home, ".ssh"))], beforeFiles)
  assert.deepEqual([...keychain.items].filter(([key]) => !key.includes(".dev.")).sort(), beforeKeychain)
  assert.ok(keychain.writes.length > 0)
  for (const write of keychain.writes) assert.match(write, /^org\.silo\.dev\./)
  assert.ok(keychain.read(DEVELOPMENT.keychain.github, "account"))
  const github = JSON.parse(fs.readFileSync(path.join(channelPaths(DEVELOPMENT, { home, platform: "darwin" }).data, "github.json"), "utf8"))
  assert.deepEqual(github, { revision: 0, accessEnabled: true, account: "octo" })
})

test("refuses to run while Silo Dev is running and changes nothing", async () => {
  const { home, target } = fixtureHome()
  const keychain = productionKeychain()
  await assert.rejects(run(home, keychain, { isDevRunning: () => true }), /Silo Dev is running/)
  assert.equal(fs.existsSync(target.config), false)
  assert.equal(fs.existsSync(target.state), false)
  assert.deepEqual(keychain.writes, [])
})

test("dry run changes nothing and prints no secret values", async () => {
  const { home, target } = fixtureHome()
  const keychain = productionKeychain()
  const lines = []
  const result = await run(home, keychain, { dryRun: true, includeGithubOauth: true, log: line => lines.push(line) })
  assert.equal(result.performed, false)
  assert.equal(fs.existsSync(target.state), false)
  assert.deepEqual(keychain.writes, [])
  const output = lines.join("\n")
  for (const secret of ["s3cret-one", "s3cret-two", "ghp_abc", "PRIVATE KEY", "refreshToken"]) assert.ok(!output.includes(secret), secret)
})

test("existing dev configuration needs confirmation, is backed up, and keeps its host identity", async () => {
  const { home, target } = fixtureHome()
  const keychain = productionKeychain()
  await run(home, keychain)
  const remoteConfig = path.join(target.state, "desktop-remote", "config.json")
  const own = { hostId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", enabled: true, hosts: [] }
  fs.writeFileSync(remoteConfig, JSON.stringify(own))
  fs.writeFileSync(path.join(target.config, "settings.json"), JSON.stringify({ schemaVersion: 1, settings: { theme: "light" }, onboardingDraft: null }))
  const writes = keychain.writes.length

  const declined = await run(home, keychain, { confirm: async () => false })
  assert.equal(declined.performed, false)
  assert.equal(JSON.parse(fs.readFileSync(remoteConfig, "utf8")).hosts.length, 0)
  assert.equal(keychain.writes.length, writes)

  const accepted = await run(home, keychain, { confirm: async () => true, now: () => new Date("2026-01-02T03:04:05.000Z") })
  assert.equal(accepted.performed, true)
  const merged = JSON.parse(fs.readFileSync(remoteConfig, "utf8"))
  assert.equal(merged.hostId, own.hostId)
  assert.equal(merged.enabled, true)
  assert.deepEqual(merged.hosts, HOSTS)
  assert.ok(fs.readdirSync(target.config).some(name => name.startsWith("settings.json.bak-")))
  assert.equal(JSON.parse(fs.readFileSync(path.join(target.config, "settings.json"), "utf8")).settings.theme, "dark")
})

test("running twice with --yes is idempotent", async () => {
  const { home, target } = fixtureHome()
  const keychain = productionKeychain()
  await run(home, keychain)
  const first = [...snapshot(target.config), ...snapshot(target.state)].filter(entry => !entry.includes(".bak-"))
  await run(home, keychain, { yes: true })
  assert.deepEqual([...snapshot(target.config), ...snapshot(target.state)].filter(entry => !entry.includes(".bak-")), first)
})

test("backups of private Dev files use private modes even when the old files were readable", async t => {
  const { home, source, target } = fixtureHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const keychain = productionKeychain()
  await run(home, keychain)
  const productionBefore = snapshot(source.state)
  const key = path.join(target.state, "desktop-remote", "id_ed25519")
  const settings = path.join(target.config, "settings.json")
  for (const file of [key, settings]) {
    fs.writeFileSync(file, "old private Dev contents")
    fs.chmodSync(file, 0o666)
  }
  await run(home, keychain, { yes: true, now: () => new Date("2026-01-02T03:04:05.000Z") })
  for (const file of [key, settings]) {
    const backup = `${file}.bak-2026-01-02T03-04-05-000Z`
    assert.equal(fs.readFileSync(backup, "utf8"), "old private Dev contents")
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  assert.deepEqual(snapshot(source.state), productionBefore)
})

test("missing or damaged production state is skipped, not fatal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "silo-import-empty-"))
  const lines = []
  const empty = await run(home, memoryKeychain(), { log: line => lines.push(line) })
  assert.equal(empty.performed, false)
  assert.equal(fs.existsSync(path.join(home, ".silo-dev")), false)

  const source = channelPaths(PRODUCTION, { home, platform: "darwin" })
  fs.mkdirSync(source.config, { recursive: true })
  fs.writeFileSync(path.join(source.config, "settings.json"), "{not json")
  const damaged = await run(home, memoryKeychain())
  assert.equal(damaged.performed, false)
  assert.ok(damaged.skipped.some(line => line.includes("unreadable")))
})

test("keychain writes outside the dev services are refused by the guard", async () => {
  const { home } = fixtureHome()
  const keychain = productionKeychain()
  keychain.write = () => { throw new Error("should be unreachable") }
  await assert.rejects(run(home, keychain), /should be unreachable/)
})

test("sanitizers keep only intended fields", () => {
  assert.deepEqual(Object.keys(sanitizeSettings({ settings: { theme: "dark", launchAtLogin: true, startupWorkspaceIds: [] } }).settings), ["theme"])
  for (const key of ["launchAtLogin", "startWorkspacesAtLaunch", "startupWorkspaceIds"]) assert.ok(!COPIED_SETTINGS.includes(key))
  assert.deepEqual(sanitizeSecrets({ secrets: [{ id: "a", name: "N", valueId: "v", workspaces: ["x"], allowedDomains: [] }] }).secrets[0].workspaces, [])
})

test("Linux layout uses the XDG directories and the same state directory names", () => {
  const home = "/home/u"
  const prod = channelPaths(PRODUCTION, { home, platform: "linux", env: {} })
  const dev = channelPaths(DEVELOPMENT, { home, platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" } })
  assert.equal(prod.config, "/home/u/.config/org.silo.preview")
  assert.equal(prod.data, "/home/u/.local/share/org.silo.preview")
  assert.equal(prod.state, "/home/u/.silo")
  assert.equal(dev.config, "/cfg/org.silo.dev")
  assert.equal(dev.state, "/home/u/.silo-dev")
})

test("detects Silo Dev processes but not production", () => {
  assert.equal(devProcessRunning("/Applications/Silo Dev.app/Contents/MacOS/silo-ui"), true)
  assert.equal(devProcessRunning("/x/target/debug/silo-ui"), true)
  assert.equal(devProcessRunning("/home/u/.local/bin/silo-remote-dev --remote-bridge"), true)
  assert.equal(devProcessRunning("/Applications/Silo.app/Contents/MacOS/silo-ui\n/usr/bin/ssh host"), false)
  assert.equal(randomUUID().length, 36)
})

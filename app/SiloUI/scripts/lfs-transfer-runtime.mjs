import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { validateArchiveEntries } from './git-runtime.mjs'

const execute = promisify(execFile)
export const LFS_TRANSFER_COMMIT = '971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b'
export const LFS_TRANSFER_SOURCE_SHA256 = '92d6720202aa5a059c6683df78f1fa47722c0c48ff1dc4ebfc0bc8137d988702'
export const LFS_TRANSFER_SOURCE_URL = `https://codeload.github.com/charmbracelet/git-lfs-transfer/tar.gz/${LFS_TRANSFER_COMMIT}`
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function lfsTransferGuestArchitecture(targetTriple) {
  if (targetTriple === 'aarch64-apple-darwin' || targetTriple === 'aarch64-unknown-linux-gnu') return 'arm64'
  if (targetTriple === 'x86_64-unknown-linux-gnu') return 'amd64'
  throw new Error(`Unsupported Git LFS transfer target: ${targetTriple}`)
}

async function normalizeModes(directory) {
  await chmod(directory, 0o755)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await normalizeModes(path)
    else if (entry.isFile()) await chmod(path, entry.name === 'git-lfs-transfer' ? 0o755 : 0o644)
    else throw new Error('Git LFS transfer runtime contains an unsupported file type')
  }
}

// The server runs inside the Linux guest, including when Silo's host is macOS.
// There is no stable upstream binary release; build the immutable source pin.
export async function stageLfsTransferRuntime({ appRoot, targetTriple, fetchBytes }) {
  const architecture = lfsTransferGuestArchitecture(targetTriple)
  const tauriRoot = resolve(appRoot, 'src-tauri')
  const root = join(tauriRoot, 'runtime', 'lfs-transfer')
  const cache = join(tauriRoot, 'target', 'runtime-cache', 'git-lfs-transfer', LFS_TRANSFER_COMMIT)
  const cachedBuild = join(cache, 'builds', `linux-${architecture}`)
  const binaryPath = join(root, 'git-lfs-transfer')
  const manifestPath = join(root, 'manifest.json')
  const valid = async directory => {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      await readFile(join(directory, 'LICENSE-MIT.txt'))
      await readFile(join(directory, 'licenses', 'Go-LICENSE'))
      return manifest.commit === LFS_TRANSFER_COMMIT && manifest.sourceSha256 === LFS_TRANSFER_SOURCE_SHA256 &&
        manifest.architecture === architecture && manifest.binarySha256 === sha256(await readFile(join(directory, 'git-lfs-transfer')))
    } catch { return false }
  }
  if (await valid(root)) {
    await normalizeModes(root)
    return { root, binaryPath, manifestPath }
  }
  if (await valid(cachedBuild)) {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    for (const name of ['git-lfs-transfer', 'manifest.json', 'LICENSE-MIT.txt', 'licenses']) {
      await cp(join(cachedBuild, name), join(root, name), { recursive: true })
    }
    await normalizeModes(root)
    return { root, binaryPath, manifestPath }
  }

  const stage = join(tauriRoot, 'runtime', `.lfs-transfer-staging-${process.pid}`)
  const archivePath = join(cache, 'source.tar.gz')
  await mkdir(cache, { recursive: true })
  let bytes
  try { bytes = await readFile(archivePath) } catch { /* Download below. */ }
  if (!bytes || sha256(bytes) !== LFS_TRANSFER_SOURCE_SHA256) bytes = Buffer.from(await fetchBytes(LFS_TRANSFER_SOURCE_URL))
  if (sha256(bytes) !== LFS_TRANSFER_SOURCE_SHA256) throw new Error('Git LFS transfer source checksum mismatch')
  await writeFile(archivePath, bytes)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    const listing = await execute('tar', ['-tzf', archivePath], { maxBuffer: 1024 * 1024 })
    validateArchiveEntries(listing.stdout.trim().split('\n'), 'Git LFS transfer source')
    const source = join(cache, `source-${process.pid}`)
    await rm(source, { recursive: true, force: true })
    await mkdir(source, { recursive: true })
    try {
      await execute('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source])
      await execute('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', join(stage, 'git-lfs-transfer'), '.'], {
        cwd: source,
        env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: architecture, GOWORK: 'off', GOSUMDB: 'sum.golang.org' },
        maxBuffer: 4 * 1024 * 1024,
      })
      await copyFile(join(source, 'LICENSE'), join(stage, 'LICENSE-MIT.txt'))
      const licenses = join(stage, 'licenses')
      await mkdir(licenses, { recursive: true })
      const modules = await execute('go', ['list', '-mod=readonly', '-deps', '-f', '{{if .Module}}{{.Module.Path}}\t{{.Module.Dir}}{{end}}', '.'], {
        cwd: source, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: architecture, GOWORK: 'off', GOSUMDB: 'sum.golang.org' },
      })
      for (const line of new Set(modules.stdout.trim().split('\n').filter(Boolean))) {
        const [module, directory] = line.split('\t')
        const notices = (await readdir(directory)).filter(name => /^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(name))
        if (notices.length === 0) throw new Error(`No license found for linked Go module ${module}`)
        const destination = join(licenses, encodeURIComponent(module))
        await mkdir(destination, { recursive: true })
        for (const notice of notices) await copyFile(join(directory, notice), join(destination, notice))
      }
      const goRoot = await execute('go', ['env', 'GOROOT'])
      const compilerRoot = goRoot.stdout.trim()
      const compilerLicense = await readFile(join(compilerRoot, 'LICENSE')).catch(error => {
        if (error.code !== 'ENOENT') throw error
        // Homebrew keeps the license alongside libexec instead of inside GOROOT.
        return readFile(join(dirname(compilerRoot), 'LICENSE'))
      })
      await writeFile(join(licenses, 'Go-LICENSE'), compilerLicense)
    } finally {
      await rm(source, { recursive: true, force: true })
    }
    await chmod(join(stage, 'git-lfs-transfer'), 0o755)
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1, distribution: 'charmbracelet/git-lfs-transfer', commit: LFS_TRANSFER_COMMIT,
      sourceSha256: LFS_TRANSFER_SOURCE_SHA256, platform: 'linux', architecture,
      binarySha256: sha256(await readFile(join(stage, 'git-lfs-transfer'))),
    }, null, 2)}\n`)
    await normalizeModes(stage)
    await rm(root, { recursive: true, force: true })
    await rename(stage, root)
    await rm(cachedBuild, { recursive: true, force: true })
    await cp(root, cachedBuild, { recursive: true })
    return { root, binaryPath, manifestPath }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { LFS_TRANSFER_COMMIT, LFS_TRANSFER_SOURCE_SHA256, lfsTransferGuestArchitecture, stageLfsTransferRuntime } from './lfs-transfer-runtime.mjs'

test('host target selects Linux guest architecture and rejects unsupported hosts', () => {
  assert.equal(lfsTransferGuestArchitecture('aarch64-apple-darwin'), 'arm64')
  assert.equal(lfsTransferGuestArchitecture('aarch64-unknown-linux-gnu'), 'arm64')
  assert.equal(lfsTransferGuestArchitecture('x86_64-unknown-linux-gnu'), 'amd64')
  assert.throws(() => lfsTransferGuestArchitecture('../../outside'), /Unsupported/)
})

test('unverified source is rejected before any Go build can execute', async t => {
  const root = await mkdtemp(join(tmpdir(), 'silo-lfs-packaging-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(stageLfsTransferRuntime({ appRoot: root, targetTriple: 'aarch64-apple-darwin',
    fetchBytes: async () => Buffer.from('not the pinned source') }), /checksum mismatch/)
})


test('cached module licenses stay writable across repeated native resource copies', async t => {
  const appRoot = await mkdtemp(join(tmpdir(), 'silo-lfs-license-modes-'))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  const cache = join(appRoot, 'src-tauri/target/runtime-cache/git-lfs-transfer', LFS_TRANSFER_COMMIT, 'builds/linux-arm64')
  await mkdir(join(cache, 'licenses/example-module'), { recursive: true })
  const binary = Buffer.from('cached executable fixture')
  await writeFile(join(cache, 'git-lfs-transfer'), binary)
  await writeFile(join(cache, 'LICENSE-MIT.txt'), 'MIT')
  await writeFile(join(cache, 'licenses/Go-LICENSE'), 'Go')
  await writeFile(join(cache, 'licenses/example-module/LICENSE'), 'Module license')
  await chmod(join(cache, 'licenses/example-module/LICENSE'), 0o444)
  await writeFile(join(cache, 'manifest.json'), JSON.stringify({
    commit: LFS_TRANSFER_COMMIT, sourceSha256: LFS_TRANSFER_SOURCE_SHA256, architecture: 'arm64',
    binarySha256: createHash('sha256').update(binary).digest('hex'),
  }))
  const options = { appRoot, targetTriple: 'aarch64-apple-darwin',
    fetchBytes: async () => { throw new Error('A valid compiled cache needs no download') } }
  const result = await stageLfsTransferRuntime(options)
  const notice = join(result.root, 'licenses/example-module/LICENSE')
  assert.equal((await stat(notice)).mode & 0o777, 0o644)
  assert.equal((await stat(result.binaryPath)).mode & 0o777, 0o755)
  await chmod(notice, 0o444)
  await stageLfsTransferRuntime(options)
  await writeFile(notice, 'Simulated repeated native resource copy')
  assert.equal((await stat(notice)).mode & 0o777, 0o644)
})

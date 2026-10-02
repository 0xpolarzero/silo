import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { LFS_TRANSFER_COMMIT, LFS_TRANSFER_SOURCE_SHA256, lfsTransferGuestArchitecture, readGoCompilerLicense, stageLfsTransferRuntime } from './lfs-transfer-runtime.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const compiler = { GOVERSION: 'go1.25.1', GOROOT: '/fixture/go', GOTOOLCHAIN: 'auto',
  GOFLAGS: '', GOEXPERIMENT: '', GOAMD64: 'v1', GOARM64: 'v8.0', GOFIPS140: 'off' }
const recipeSha256 = digest(await readFile(new URL('./lfs-transfer-runtime.mjs', import.meta.url)))
const buildIdentity = { goVersion: compiler.GOVERSION, goToolchain: compiler.GOTOOLCHAIN, recipeSha256,
  environment: { GOFLAGS: '', GOEXPERIMENT: '', GOAMD64: 'v1', GOARM64: 'v8.0', GOFIPS140: 'off' } }
const probeCompiler = async (program, args, options) => {
  assert.equal(program, 'go')
  assert.deepEqual(args, ['env', '-json', ...Object.keys(compiler)])
  assert.match(await readFile(join(options.cwd, 'go.mod'), 'utf8'), /^go 1\.25\.0$/m)
  assert.equal(options.env.GOWORK, 'off')
  assert.equal(options.env.GOOS, 'linux')
  return { stdout: JSON.stringify(compiler) }
}

async function compiledFixture(directory, identity = buildIdentity) {
  await mkdir(join(directory, 'licenses'), { recursive: true })
  const binary = Buffer.from('cached executable fixture')
  await writeFile(join(directory, 'git-lfs-transfer'), binary)
  await writeFile(join(directory, 'LICENSE-MIT.txt'), 'MIT')
  await writeFile(join(directory, 'licenses/Go-LICENSE'), 'Go')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    schemaVersion: identity ? 2 : 1, commit: LFS_TRANSFER_COMMIT, sourceSha256: LFS_TRANSFER_SOURCE_SHA256,
    architecture: 'arm64', binarySha256: digest(binary), ...(identity ? { buildIdentity: identity } : {}),
  }))
}

test('changed effective Go flags reject a previously compiled executable', async t => {
  const appRoot = await mkdtemp(join(tmpdir(), 'silo-lfs-effective-flags-'))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  await compiledFixture(join(appRoot, 'src-tauri/runtime/lfs-transfer'))
  await assert.rejects(stageLfsTransferRuntime({ appRoot, targetTriple: 'aarch64-apple-darwin',
    run: async (...args) => {
      await probeCompiler(...args)
      return { stdout: JSON.stringify({ ...compiler, GOFLAGS: '-tags=changed' }) }
    }, fetchStream: async () => { throw new Error('Rebuild required') } }), /Rebuild required/)
})

for (const name of ['source digest', 'binary digest']) {
  test(`matching compiler identity still rejects changed ${name}`, async t => {
    const appRoot = await mkdtemp(join(tmpdir(), 'silo-lfs-digests-'))
    t.after(() => rm(appRoot, { recursive: true, force: true }))
    const directory = join(appRoot, 'src-tauri/runtime/lfs-transfer')
    await compiledFixture(directory)
    if (name === 'binary digest') await writeFile(join(directory, 'git-lfs-transfer'), 'tampered')
    else {
      const path = join(directory, 'manifest.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.sourceSha256 = '0'.repeat(64)
      await writeFile(path, JSON.stringify(manifest))
    }
    await assert.rejects(stageLfsTransferRuntime({ appRoot, targetTriple: 'aarch64-apple-darwin', run: probeCompiler,
      fetchStream: async () => { throw new Error('Rebuild required') } }), /Rebuild required/)
  })
}

for (const location of ['runtime/lfs-transfer', `target/runtime-cache/git-lfs-transfer/${LFS_TRANSFER_COMMIT}/builds/linux-arm64`]) {
  for (const [name, identity] of [
    ['legacy manifest', undefined],
    ['compiler upgrade', { ...buildIdentity, goVersion: 'go1.25.0' }],
    ['requested toolchain', { ...buildIdentity, goToolchain: 'go1.25.1' }],
    ['build recipe', { ...buildIdentity, recipeSha256: '0'.repeat(64) }],
    ['build flags', { ...buildIdentity, environment: { ...buildIdentity.environment, GOFLAGS: '-tags=old' } }],
  ]) {
    test(`${name} invalidates ${location}`, async t => {
      const appRoot = await mkdtemp(join(tmpdir(), 'silo-lfs-cache-identity-'))
      t.after(() => rm(appRoot, { recursive: true, force: true }))
      await compiledFixture(join(appRoot, 'src-tauri', location), identity ?? null)
      let downloads = 0
      await assert.rejects(stageLfsTransferRuntime({ appRoot, targetTriple: 'aarch64-apple-darwin', run: probeCompiler,
        fetchStream: async () => { downloads++; return Readable.from([Buffer.from('unverified rebuild source')]) } }), /source checksum mismatch/)
      assert.equal(downloads, 1, 'Rejected executable must enter the verified source build path')
    })
  }
}

test('compiler selection changes reject both caches even when their binary digests match', async t => {
  const appRoot = await mkdtemp(join(tmpdir(), 'silo-lfs-selected-compiler-'))
  t.after(() => rm(appRoot, { recursive: true, force: true }))
  for (const directory of ['runtime/lfs-transfer', `target/runtime-cache/git-lfs-transfer/${LFS_TRANSFER_COMMIT}/builds/linux-arm64`]) {
    await compiledFixture(join(appRoot, 'src-tauri', directory))
  }
  await assert.rejects(stageLfsTransferRuntime({ appRoot, targetTriple: 'aarch64-apple-darwin',
    run: async (...args) => {
      await probeCompiler(...args)
      return { stdout: JSON.stringify({ ...compiler, GOVERSION: 'go1.25.2' }) }
    }, fetchStream: async () => { throw new Error('Rebuild required') } }), /Rebuild required/)
})

test('Debian Go uses the copyright notice of the package owning its compiler', async t => {
  const root = await mkdtemp(join(tmpdir(), 'silo-go-debian-license-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const compilerRoot = join(root, 'usr/lib/go-1.26')
  const docsRoot = join(root, 'usr/share/doc')
  await mkdir(join(docsRoot, 'golang-1.26-go'), { recursive: true })
  await writeFile(join(docsRoot, 'golang-1.26-go/copyright'), 'The Go Authors license notice')
  const run = async (program, args) => {
    assert.equal(program, 'dpkg-query')
    assert.deepEqual(args, ['--search', join(compilerRoot, 'bin/go')])
    return { stdout: `golang-1.26-go:amd64: ${join(compilerRoot, 'bin/go')}\n` }
  }
  assert.equal((await readGoCompilerLicense(compilerRoot, { run, docsRoot })).toString(), 'The Go Authors license notice')
})

test('official and Homebrew Go license layouts do not need a package manager', async t => {
  const root = await mkdtemp(join(tmpdir(), 'silo-go-license-layouts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const compilerRoot = join(root, 'go/libexec')
  await mkdir(compilerRoot, { recursive: true })
  const run = async () => { throw new Error('Must not query a package manager') }
  await writeFile(join(root, 'go/LICENSE'), 'Homebrew Go license')
  assert.equal((await readGoCompilerLicense(compilerRoot, { run })).toString(), 'Homebrew Go license')
  await writeFile(join(compilerRoot, 'LICENSE'), 'Official Go license')
  assert.equal((await readGoCompilerLicense(compilerRoot, { run })).toString(), 'Official Go license')
})

test('Go license discovery refuses package output that does not own the compiler', async () => {
  await assert.rejects(readGoCompilerLicense('/nonexistent/silo-go-license', {
    run: async () => ({ stdout: '../other: /nonexistent/silo-go-license/bin/go\nother: /usr/bin/go\n' }),
  }), /No package copyright notice/)
})

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
    run: probeCompiler,
    fetchStream: async () => Readable.from([Buffer.from('not the pinned source')]) }), /checksum mismatch/)
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
    schemaVersion: 2, commit: LFS_TRANSFER_COMMIT, sourceSha256: LFS_TRANSFER_SOURCE_SHA256, architecture: 'arm64', buildIdentity,
    binarySha256: createHash('sha256').update(binary).digest('hex'),
  }))
  const options = { appRoot, targetTriple: 'aarch64-apple-darwin', run: probeCompiler,
    fetchStream: async () => { throw new Error('A valid compiled cache needs no download') } }
  const result = await stageLfsTransferRuntime(options)
  const notice = join(result.root, 'licenses/example-module/LICENSE')
  assert.equal((await stat(notice)).mode & 0o777, 0o644)
  assert.equal((await stat(result.binaryPath)).mode & 0o777, 0o755)
  await chmod(notice, 0o444)
  await stageLfsTransferRuntime(options)
  await writeFile(notice, 'Simulated repeated native resource copy')
  assert.equal((await stat(notice)).mode & 0o777, 0o644)
})

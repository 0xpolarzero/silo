// Opt in with SILO_TEST_ZCODE_BUNDLE=/absolute/path/to/zcode.cjs.
// Real TLS and installed provider transport; no provider account or VM required.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const bundle = process.env.SILO_TEST_ZCODE_BUNDLE
const run = promisify(execFile)
test('ZCode TLS: server launch boundary and provider CA selection',
  { skip: !bundle, timeout: 60000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'silo-zcode-tls-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const openssl = (...args) => execFileSync('openssl', args, { cwd: root, stdio: 'pipe' })
    for (const name of ['sandbox', 'application']) {
      openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', `/CN=Silo test ${name} CA`, '-keyout', `${name}.key`, '-out', `${name}.pem`)
    }
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
      '-keyout', 'server.key', '-out', 'server.csr')
    writeFileSync(join(root, 'extensions'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'sandbox.pem', '-CAkey', 'sandbox.key',
      '-CAcreateserial', '-days', '1', '-extfile', 'extensions', '-out', 'server.pem')
    const sandbox = readFileSync(join(root, 'sandbox.pem'))
    writeFileSync(join(root, 'combined.pem'), Buffer.concat([sandbox, readFileSync(join(root, 'application.pem'))]))
    const server = https.createServer({ key: readFileSync(join(root, 'server.key')),
      cert: Buffer.concat([readFileSync(join(root, 'server.pem')), sandbox]) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const url = `https://127.0.0.1:${server.address().port}/api/anthropic`
    await t.test('real server sanitizer and spawn lose trust; startup propagation restores provider and tool TLS', async () => {
      const {stdout} = await run(process.execPath,
        [fileURLToPath(new URL('./tls/zcode-parent.mjs', import.meta.url)), bundle, url], {
          env: {PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: join(root, 'sandbox.pem'),
            ZCODE_CUA_PERMISSION_BROKER_TOKEN: 'synthetic-do-not-propagate'},
          timeout: 45000,
        })
      const result = JSON.parse(stdout)
      assert.deepEqual(result.parent, {native: 200, provider: 200})
      const original = result.children.original.agent
      assert.equal(original.startupExtraCaPresent, false)
      assert.equal(original.providerCaPresent, false)
      for (const probe of ['native', 'provider']) {
        assert.deepEqual(original.results[probe].codes,
          ['MODEL_TLS_VALIDATION_FAILED', 'SELF_SIGNED_CERT_IN_CHAIN'])
        for (const fix of ['preserveExtraCa', 'explicitCa']) {
          assert.equal(result.children[fix].agent.results[probe].status, 200)
        }
        for (const child of Object.values(result.children)) {
          assert.equal(child.tool.results[probe].status, 200)
          assert.equal(child.agent.brokerTokenPresent, false)
          assert.equal(child.tool.brokerTokenPresent, false)
        }
      }
      assert.equal(result.children.preserveExtraCa.agent.providerCaPresent, false)
      assert.equal(result.children.explicitCa.agent.providerCaPresent, true)
      t.diagnostic(`Launch boundary verified on ${result.runtime} ${result.platform}/${result.arch}; extract ${result.extractSha256}`)
    })
    const probe = async (startupCA, customCA) => {
      const env = { PATH: process.env.PATH }
      if (startupCA) env.NODE_EXTRA_CA_CERTS = join(root, startupCA)
      const args = [fileURLToPath(new URL('./tls/zcode-worker.mjs', import.meta.url)), bundle, url]
      if (customCA) args.push(join(root, customCA))
      const { stdout } = await run(process.execPath, args, { env, timeout: 15000 })
      return JSON.parse(stdout)
    }
    const trusted = await probe('sandbox.pem')
    t.diagnostic(`Installed ZCode bundle SHA-256: ${trusted.sha256}`)
    assert.equal(trusted.results.native.status, 200)
    assert.equal(trusted.results.provider.status, 200)
    const missing = await probe()
    assert.ok(missing.results.provider.codes.includes('MODEL_TLS_VALIDATION_FAILED'))
    const replaced = await probe('sandbox.pem', 'application.pem')
    assert.equal(replaced.results.native.status, 200)
    assert.deepEqual(replaced.results.provider.codes,
      ['MODEL_TLS_VALIDATION_FAILED', 'SELF_SIGNED_CERT_IN_CHAIN'])
    assert.equal(replaced.results.provider.message, 'TLS validation failed for the provider request.')
    for (const ca of ['sandbox.pem', 'combined.pem']) {
      const repaired = await probe('sandbox.pem', ca)
      assert.equal(repaired.results.provider.status, 200)
    }
    t.diagnostic('Reproduced: native TLS succeeds, provider custom CA fails; including sandbox CA restores verified TLS.')
  })

// Starts with NODE_EXTRA_CA_CERTS already set, just like the remote server.
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadLaunchBoundary } from './zcode-launch.mjs'
import { loadTransport } from './zcode-transport.mjs'

const [bundle, url] = process.argv.slice(2)
const launch = loadLaunchBoundary()
const transport = loadTransport(bundle)
const probeArgs = [fileURLToPath(new URL('./zcode-worker.mjs', import.meta.url)), bundle, url]

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', expired = false
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM') }, 15000)
    child.stdin?.end()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (expired || code !== 0) return reject(new Error(`Probe failed (${code}, timeout=${expired}): ${stderr}`))
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
  })
}

const parent = {}
for (const [name, request] of Object.entries({native: fetch, provider: transport.create({env: {}})})) {
  const response = await request(url, {signal: AbortSignal.timeout(5000)})
  await response.arrayBuffer()
  parent[name] = response.status
}

// The report observes this blob on the child, but the supplied call-site slice
// does not include where it is attached. Supply it explicitly as a fixture.
const toolEnv = launch.buildZCodeToolEnvPassthroughEnv(process.env)
const cases = {
  original: launch.buildAgentRuntimeEnv({}),
  // Minimal candidate: preserve Node's additional trust before exec, without
  // selecting a provider CA that replaces the ordinary public root set.
  preserveExtraCa: {NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS},
  // Candidate demonstrated remotely: use the existing explicit CA builder.
  explicitCa: launch.buildAgentRuntimeEnv({caCertPath: process.env.NODE_EXTRA_CA_CERTS}),
}
const children = {}
for (const [name, overrides] of Object.entries(cases)) {
  const env = {...toolEnv, ...overrides}
  const agent = await collect(launch.spawnAgent({command: process.execPath},
    {args: probeArgs, cwd: process.cwd()}, env))
  // Model the tool boundary by applying the real captured passthrough data.
  // This checks TLS behavior, not merely that a JSON key survived sanitation.
  const captured = JSON.parse(toolEnv.ZCODE_TOOL_ENV_PASSTHROUGH_JSON)
  const tool = await collect(spawn(process.execPath, probeArgs, {
    env: {PATH: process.env.PATH, ...captured}, stdio: ['pipe', 'pipe', 'pipe'],
  }))
  children[name] = {agent, tool}
}
console.log(JSON.stringify({parent, children, extractSha256: launch.sha256,
  runtime: process.version, platform: process.platform, arch: process.arch}))

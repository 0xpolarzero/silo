import { loadTransport } from './zcode-transport.mjs'

const [bundle, url, caFile] = process.argv.slice(2)
const adapter = loadTransport(bundle)
const results = {}
for (const [name, request] of Object.entries({
  native: fetch,
  // Use the real provider network transport with proxy routing absent.
  provider: adapter.create({ env: {
    ZCODE_AGENT_CA_CERT: process.env.ZCODE_AGENT_CA_CERT,
  }, ...(caFile ? { caCertFile: caFile } : {}) }),
})) {
  try {
    const response = await request(url, { signal: AbortSignal.timeout(5000) })
    await response.arrayBuffer()
    results[name] = { status: response.status }
  } catch (error) {
    const normalized = adapter.normalize(error)
    const codes = []
    for (let current = normalized; current; current = current.cause) {
      if (current.code) codes.push(current.code)
    }
    results[name] = { codes, message: normalized.message }
  }
}
console.log(JSON.stringify({ sha256: adapter.sha256, results,
  startupExtraCaPresent: Boolean(process.env.NODE_EXTRA_CA_CERTS),
  providerCaPresent: Boolean(process.env.ZCODE_AGENT_CA_CERT),
  brokerTokenPresent: Boolean(process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN),
}))

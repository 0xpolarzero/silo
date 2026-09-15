// Generate a standalone probe for the guest: no npm install in the VM.
import {writeFileSync} from 'node:fs'
import {extractTransport} from './zcode-transport.mjs'
import {extractLaunchBoundary} from './zcode-launch.mjs'
const [bundle, output] = process.argv.slice(2)
const {code, sha256} = extractTransport(bundle)
const {definitions, spawnStatement} = extractLaunchBoundary()
writeFileSync(output, `
${code}
${definitions}
const tls = require('node:tls');
const import_node_child_process8 = require('node:child_process');
async function probe() {
  const results = {};
  for (const hostname of ['api.z.ai', 'api.github.com']) {
    const endpoint = 'https://' + hostname + (hostname === 'api.z.ai' ? '/api/anthropic/v1/messages' : '/');
    results[hostname] = {};
    for (const [name, request] of Object.entries({native: fetch, provider: transport({env: process.env})})) {
      try {
        const response = await request(endpoint, {signal: AbortSignal.timeout(15000)});
        await response.body?.cancel();
        results[hostname][name] = {status: response.status};
      } catch(error) {
        const codes = [];
        for(let item = normalize(error); item; item = item.cause) if(item.code) codes.push(item.code);
        results[hostname][name] = {codes};
      }
    }
  }
  return results;
}
async function certificate(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host, port: 443, servername: host}, () => {
      const cert = socket.getPeerCertificate();
      resolve({issuer: cert.issuer.CN, fingerprint: cert.fingerprint256}); socket.end();
    });
    socket.setTimeout(15000, () => socket.destroy(new Error('TLS probe timeout: '+host)));
    socket.once('error', reject);
  });
}
function launch(caCertPath) {
  return new Promise((resolve, reject) => {
    const effectiveCommand = {command: process.execPath};
    const spawnPreflight = {args: [__filename, '--child'], cwd: '/tmp'};
    const params = {workspaceIdentity: 'silo-tls-live-test'};
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    const spawnEnv = {...buildZCodeToolEnvPassthroughEnv(process.env), ...buildAgentRuntimeEnv({}),
      ...(caCertPath ? {NODE_EXTRA_CA_CERTS: caCertPath} : {})};
    const shouldSpawnInDetachedProcessGroup = () => false;
    const buildE2EAgentCoverageEnv = () => ({});
    ${spawnStatement}
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 70000);
    child.stdin.end();
    child.stdout.on('data', chunk => out += chunk);
    child.stderr.on('data', chunk => err += chunk);
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      if(status !== 0) return reject(new Error('child failed: '+status+' '+err));
      try {resolve(JSON.parse(out))} catch(error) {reject(error)}
    });
  });
}
(async () => {
  if(process.argv.includes('--child')) return console.log(JSON.stringify(await probe()));
  const certificates = {};
  for(const host of ['api.z.ai', 'api.github.com']) certificates[host] = await certificate(host);
  console.log(JSON.stringify({node: process.version, arch: process.arch, kernel: require('node:os').release(), bundleSha256: '${sha256}',
    certificates, original: await launch(), restored: await launch(process.env.NODE_EXTRA_CA_CERTS)}, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1});
`)

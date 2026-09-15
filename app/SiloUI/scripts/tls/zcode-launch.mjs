// Evaluate the reviewed, user-supplied definitions and actual spawn statement.
// No installed server is patched or launched. Keep unrelated server dependencies
// explicit; this is a launch-boundary test, not the complete app server.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as childProcess from 'node:child_process'

export function extractLaunchBoundary() {
  const source = readFileSync(new URL('./fixtures/zcode-server-runtime-env.extract.txt', import.meta.url), 'utf8')
  const sha256 = createHash('sha256').update(source).digest('hex')
  if (sha256 !== '1c202392dde305b15b875a9d458ba59136354ebcc118eb9854695caf11476aee') {
    throw new Error('Review changed ZCode extract before updating its hash')
  }
  const definitions = source.split('// ==== END OF EVALUABLE DEFINITIONS ====')[0]
    .replace(/^\d+\t/gm, '')
  const spawnLines = source.split('\n').flatMap(line => {
    const match = /^(\d+)\t(.*)$/.exec(line)
    return match && Number(match[1]) >= 198124 && Number(match[1]) <= 198139 ? [match[2]] : []
  })
  if (spawnLines.length !== 16) throw new Error('Incomplete ZCode spawn statement')
  return {definitions, spawnStatement: spawnLines.join('\n'), sha256}
}

export function loadLaunchBoundary() {
  const {definitions, spawnStatement, sha256} = extractLaunchBoundary()
  const load = new Function('import_node_child_process8', 'process', `
    ${definitions}
    function spawnAgent(effectiveCommand, spawnPreflight, spawnEnv) {
      const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
      const params = {workspaceIdentity: 'silo-tls-test'};
      const shouldSpawnInDetachedProcessGroup = () => false;
      const buildE2EAgentCoverageEnv = () => ({});
      ${spawnStatement}
      return child;
    }
    return { spawnAgent, buildAgentRuntimeEnv, buildZCodeToolEnvPassthroughEnv };
  `)
  return { ...load(childProcess, process), sha256 }
}

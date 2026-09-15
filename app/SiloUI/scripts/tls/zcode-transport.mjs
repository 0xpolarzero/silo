// Diagnostic adapter for a locally supplied ZCode bundle. Never runs its CLI,
// reads account settings, or copies proprietary source into this repository.
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'

export function extractTransport(path) {
  const source = readFileSync(path, 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  // Fail closed when the installed bundle changes its internal symbols.
  const names = ['bve', 'Dxo', 'Nxo', 'Lxo', 'Bxo', 'Ycr', 'jxo', 'Fxo',
    'o$t', 'eVe', 'a$t', 'tVe', 'A0e', 'hjn', 'Xqe', 'hJ', 's$t', 'r$t',
    'yjn', 'fJ', 'vjn', 'edr', 'lrt', 'tdr']
  const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration)
    .map(node => [node.name?.text, node.getText(ast)]))
  for (const name of names) {
    if (!declarations.has(name)) throw new Error(`Unsupported ZCode bundle: missing ${name}`)
  }
  for (const marker of ['a(bve,"createNetworkProxyFetch")', 'a(edr,"normalizeModelTlsFailure")']) {
    if (!source.includes(marker)) throw new Error('Unsupported ZCode transport layout')
  }
  const errorDeclaration = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(ast) === 'crt'))
  if (!errorDeclaration) throw new Error('Unsupported ZCode TLS error layout')
  const constants = ['Ace', 'kZ', 'Ece'].map(name => {
    const match = source.match(new RegExp(`\\b${name}="([A-Z_]+)"`))
    if (!match) throw new Error(`Unsupported ZCode constant: ${name}`)
    return `const ${name}=${JSON.stringify(match[1])};`
  }).join('\n')
  const code = `
    const a=(value)=>value, T=(init)=>init;
    const n$t=require('node:fs'), irt={default:require('node:http')},
      xve={default:require('node:https')}, Qcr=require('node:stream');
    ${constants}
    ${names.map(name => declarations.get(name)).join('\n')}
    ${errorDeclaration.getText(ast)}
    crt();
    globalThis.transport=bve;
    globalThis.normalize=edr;
  `
  return { code, sha256: createHash('sha256').update(source).digest('hex') }
}

export function loadTransport(path) {
  const { code, sha256 } = extractTransport(path)
  const context = vm.createContext({ require: createRequire(import.meta.url),
    URL, Request, Response, Headers, Buffer, fetch, Error, WeakSet })
  vm.runInContext(code, context, { timeout: 5000 })
  return { create: context.transport, normalize: context.normalize, sha256 }
}

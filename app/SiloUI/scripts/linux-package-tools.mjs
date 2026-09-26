import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

const TOOL_NAMES = [
  "msb",
  "git",
  "git-lfs",
  "git-remote-http",
  "git-remote-https",
  "libkrunfw.so.5.6.1",
]

export async function stageLinuxPackageTools({ appRoot, targetTriple }) {
  if (!targetTriple.endsWith("-unknown-linux-gnu")) {
    throw new Error(`Unsupported Linux package tools target: ${targetTriple}`)
  }

  const tauriRoot = resolve(appRoot, "src-tauri")
  const sourceRoot = join(tauriRoot, "runtime")
  const binariesRoot = join(tauriRoot, "binaries")
  const destination = join(sourceRoot, "linux-package", "tools")
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const sources = [
    join(binariesRoot, `msb-${targetTriple}`),
    join(binariesRoot, `git-${targetTriple}`),
    join(binariesRoot, `git-lfs-${targetTriple}`),
    join(binariesRoot, `git-remote-http-${targetTriple}`),
    join(binariesRoot, `git-remote-https-${targetTriple}`),
    join(sourceRoot, "microsandbox", targetTriple, "lib", "libkrunfw.so.5.6.1"),
  ]

  for (const [index, source] of sources.entries()) {
    const target = join(destination, TOOL_NAMES[index])
    await copyFile(source, target)
    await chmod(target, (await stat(source)).mode & 0o777)
  }
  return { targetTriple, directory: destination, files: TOOL_NAMES.map(name => join(destination, name)) }
}

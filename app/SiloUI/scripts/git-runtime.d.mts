export interface GitRuntimeTarget {
  archive: string
  sha256: string
  gitVersionOutput: string
  minimumPlatform: string
  needsCertificateBundle: boolean
}

export interface GitLicenseArtifact {
  name: string
  url: string
  sha256: string
}

export const DUGITE_RELEASE: string
export const DUGITE_COMMIT: string
export const GIT_VERSION: string
export const GIT_LFS_VERSION: string
export const packagedGitExecutables: Readonly<{
  git: string
  gitLfs: string
  gitRemoteHttp: string
  gitRemoteHttps: string
}>
export const gitRuntimeTargets: Readonly<Record<string, Readonly<GitRuntimeTarget>>>
export const gitLicenseArtifacts: readonly Readonly<GitLicenseArtifact>[]
export function selectGitRuntime(targetTriple: string): Readonly<GitRuntimeTarget>
export function gitRuntimeSha256(bytes: ArrayBufferView): string
export function verifyGitRuntimeSha256(bytes: ArrayBufferView, expected: string, label: string): void
export function validateArchiveEntries(entries: string[], label: string): void
export function stageGitRuntime(options: {
  appRoot: string
  targetTriple: string
  fetchBytes: (url: string) => Promise<ArrayBufferView>
  selected?: GitRuntimeTarget
  licenses?: GitLicenseArtifact[]
  extractArchive?: (archiveFile: string, destination: string) => Promise<void>
}): Promise<{
  targetTriple: string
  root: string
  gitPath: string
  gitLfsPath: string
  manifestPath: string
  externalBinaries: Record<string, string>
}>

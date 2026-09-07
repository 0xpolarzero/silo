export interface RuntimeTarget {
  platform: string
  arch: string
  executableAsset: string
  executableSha256: string
  libraryAsset: string
  libraryName: string
  librarySha256: string
}

export interface LicenseArtifact {
  name: string
  url: string
  sha256: string
}

export const MICRO_SANDBOX_VERSION: string
export const LIBKRUNFW_VERSION: string
export const RELEASE_BASE_URL: string
export const runtimeTargets: Readonly<Record<string, Readonly<RuntimeTarget>>>
export const licenseArtifacts: readonly Readonly<LicenseArtifact>[]
export function resolveRuntimeTarget(
  environment: Readonly<Record<string, string | undefined>>,
  hostTriple: () => string,
): string
export function selectRuntime(targetTriple: string): Readonly<RuntimeTarget>
export function sha256(bytes: ArrayBufferView): string
export function verifySha256(bytes: ArrayBufferView, expected: string, label: string): void
export function stageRuntime(options: {
  appRoot: string
  targetTriple: string
  fetchBytes: (url: string) => Promise<ArrayBufferView>
  selected?: RuntimeTarget
  licenses?: LicenseArtifact[]
}): Promise<{
  targetTriple: string
  executablePath: string
  libraryPath: string
  manifestPath: string
}>

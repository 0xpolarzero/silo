export const LFS_TRANSFER_COMMIT: string
export const LFS_TRANSFER_SOURCE_SHA256: string
export const LFS_TRANSFER_SOURCE_URL: string
export function lfsTransferGuestArchitecture(targetTriple: string): 'arm64' | 'amd64'
export function stageLfsTransferRuntime(options: {
  appRoot: string
  targetTriple: string
  fetchBytes: (url: string) => Promise<ArrayBufferView>
}): Promise<{ root: string; binaryPath: string; manifestPath: string }>

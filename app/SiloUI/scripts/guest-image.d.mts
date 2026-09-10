export function guestArchitecture(targetTriple: string): "arm64" | "amd64"
export function verifyGuestArchive(bytes: Uint8Array, manifest: { archiveBytes: number; archiveSha256: string }): void
export function stageGuestImage(options: { appRoot: string; targetTriple: string; fetchBytes: (url: string) => Promise<Uint8Array> }): Promise<{ imageReference: string }>

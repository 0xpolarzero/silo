import type { FetchStream } from "./build-input.mjs"

export function guestArchitecture(targetTriple: string): "arm64" | "amd64"
export function verifyGuestArchive(path: string, manifest: { archiveBytes: number; archiveSha256: string }): Promise<void>
export function stageGuestImage(options: { appRoot: string; targetTriple: string; fetchStream: FetchStream }): Promise<{ imageReference: string }>

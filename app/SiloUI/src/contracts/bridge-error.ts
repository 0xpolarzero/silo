import { z } from "zod"

/** Closed native bridge contract, checked against Rust serialization in bridge-errors.json. */
export const bridgeErrorCodes = [
  "update_in_progress", "unsupported_remote_operation", "cancelled", "already_queued", "busy", "not_found", "internal",
] as const
export type BridgeErrorCode = (typeof bridgeErrorCodes)[number]
export const bridgeErrorSchema = z.object({ code: z.enum(bridgeErrorCodes), message: z.string() })
export type BridgeError = z.infer<typeof bridgeErrorSchema>

export function hasBridgeErrorCode(cause: unknown, code: BridgeErrorCode): boolean {
  const parsed = bridgeErrorSchema.safeParse(cause)
  return parsed.success && parsed.data.code === code
}

/** Unknown codes still have readable text, but do not trigger a known recovery policy. */
export function bridgeErrorMessage(cause: unknown): string | undefined {
  const parsed = z.object({ code: z.string(), message: z.string().min(1) }).safeParse(cause)
  return parsed.success ? parsed.data.message : undefined
}

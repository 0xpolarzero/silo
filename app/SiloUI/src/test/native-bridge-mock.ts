import { vi } from "vitest"

export type NativeCommandHandler = (arguments_?: Record<string, unknown>) => unknown | Promise<unknown>
export type NativeCommandHandlers = Record<string, NativeCommandHandler>

const unhandledCommands: string[] = []

/** Use with afterEach(assertNativeBridgeMocksHandled) to catch swallowed bridge errors. */
export function nativeBridgeMock(handlers: NativeCommandHandlers) {
  return vi.fn(async (command: string, arguments_?: Record<string, unknown>): Promise<unknown> => {
    if (!Object.hasOwn(handlers, command)) {
      const message = `Unhandled native command: ${command}`
      unhandledCommands.push(message)
      throw new Error(message)
    }
    return handlers[command](arguments_)
  })
}

export function assertNativeBridgeMocksHandled() {
  const omissions = unhandledCommands.splice(0)
  if (omissions.length) throw new Error(omissions.join("\n"))
}

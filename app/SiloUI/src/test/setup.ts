import "@testing-library/jest-dom/vitest"

import { afterEach, beforeEach, vi } from "vitest"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { toast } from "sonner"
import { collectUnexpectedConsoleErrors, installConsoleErrorGuard } from "./console-error-guard"

// Sonner keeps its toast store at module scope; clear it so notifications never leak between tests.
afterEach(() => { toast.dismiss() })

// Without a Tauri webview, the real `invoke`/`listen` throw inside
// transformCallback and surface only as caught console errors. Install
// Tauri's own IPC mock so modules that are not vi.mock'ed get a working
// bridge: event listeners register, and unknown commands resolve undefined.
// Suites that need specific command results still vi.mock the modules or call
// mockIPC themselves.
beforeEach(() => {
  mockIPC(() => undefined, { shouldMockEvents: true })
})
afterEach(() => { clearMocks() })

// Fail on console.error not allow-listed in console-error-guard.ts. The check
// runs in onTestFinished, after every afterEach hook, so throwing here cannot
// skip DOM cleanup or timer and mock restoration.
installConsoleErrorGuard()
beforeEach(({ onTestFinished }) => {
  onTestFinished(() => {
    const unexpected = collectUnexpectedConsoleErrors()
    if (unexpected.length > 0) {
      throw new Error(`Unexpected console.error during test:\n${unexpected.join("\n---\n")}`)
    }
  })
})

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
})

// jsdom omits matchMedia; the Sonner toaster and a few hooks call it. Individual
// suites still override this with vi.stubGlobal when they assert on media state.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverStub })
Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: () => false })
Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: () => undefined })
Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: () => undefined })
Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined })

import "@testing-library/jest-dom/vitest"

import { vi } from "vitest"

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

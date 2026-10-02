import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
Object.defineProperty(window, 'matchMedia', { value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
Element.prototype.scrollIntoView = vi.fn();

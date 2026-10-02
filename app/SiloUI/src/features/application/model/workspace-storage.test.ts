import { expect, it } from "vitest"
import { formatStorageBytes } from "./workspace-storage"

it.each([
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KiB"],
  [4096, "4.0 KiB"],
  [1024 ** 2, "1.0 MiB"],
  [1024 ** 3, "1.00 GiB"],
  [1024 ** 4, "1024.00 GiB"],
])("formats %i allocated bytes as %s", (bytes, expected) => {
  expect(formatStorageBytes(bytes)).toBe(expected)
})

import { expect, it } from "vitest"
import { formatSandboxSize } from "./delete-sandbox-copy"

it.each([
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KiB"],
  [4096, "4.0 KiB"],
  [1024 ** 2, "1 MiB"],
  [1024 ** 3, "1.0 GiB"],
])("reports %i allocated bytes in a deletion confirmation as %s", (bytes, expected) => {
  expect(formatSandboxSize(bytes)).toBe(expected)
})

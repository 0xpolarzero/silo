import { expect, it } from "vitest"
import { formatComputerSize } from "./delete-computer-copy"

it.each([
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KiB"],
  [4096, "4.0 KiB"],
  [1024 ** 2, "1 MiB"],
  [1024 ** 3, "1.0 GiB"],
])("reports %i allocated bytes in a deletion confirmation as %s", (bytes, expected) => {
  expect(formatComputerSize(bytes)).toBe(expected)
})

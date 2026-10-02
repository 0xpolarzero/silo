# Frontend type boundary fixes

## Configuration operation variants

Fixed: `parseApplicationSource` and `parseRemoteApplicationSource` accepted a
`failed` configuration operation with `error: null`, although the UI dereferences
`operation.error.workspace` after checking the status. The final
`as ApplicationSource` assertion concealed this schema/model disagreement.

Use the existing [Zod discriminated union](https://zod.dev/api#discriminated-unions)
API to validate each status with its corresponding result and error. Retain the
existing malformed-operation fallback to `null`. Both parsers now return their
inferred schema output without an assertion; the compiler checks compatibility
with `ApplicationSource`. Remove the redundant machine-model assertion as well.

Verification: `production-source-validation.test.ts` reproduced eight failures
across the local and remote parsers before the fix. It covers valid variants,
invalid status/result/error combinations, and retention of the surrounding
workspace state. These checks use deterministic fixtures, with no app launch,
VM, or user data.

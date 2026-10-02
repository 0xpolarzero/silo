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

## Legacy optional preferences

Fixed: the legacy preference snapshot passed through `startupWorkspaceIds`,
application paths, and default-selection switches without validating them. An
object in `startupWorkspaceIds` reached `new Set(settings.startupWorkspaceIds)`
on the General page and threw. Passthrough properties satisfied neither runtime
validation nor the model's declared optional types, even after removing the
parser's return assertion.

Reuse the existing settings field schemas with Zod's
[catch fallback](https://zod.dev/api#catch) for these optional properties.
Invalid values become `undefined`, while valid preferences and unknown fields
from newer Silo versions remain intact. Regression cases reproduced sixteen
failures across the local and remote parsers before the fix. The fixture checks
cover invalid collections, paths, and booleans as well as valid values and the
startup collection consumer.

Checks: 119 parser/bridge tests and seven settings UI tests passed on Node
24.11.1; typecheck, focused oxlint, and `git diff --check` passed. The settings UI
file exceeded both five-second and twenty-second test deadlines on the shared
machine, then passed alone with `--maxWorkers=1 --testTimeout=60000`. The final
run took 71.46 seconds. These are fixture checks, not live app verification.

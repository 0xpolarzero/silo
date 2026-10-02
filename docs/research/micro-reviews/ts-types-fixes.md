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

## Storage history trigger labels

Fixed: `workspace-storage-panel.tsx` asserted a plain label object was
`Record<string, string>`. A saved trigger named `__proto__` instead returned
`Object.prototype`, which React rejected as a child when opening history.
`constructor` and `toString` returned functions and caused invalid-child errors.
Both the native `ReclaimEntry.trigger: String` in `runtime/storage.rs` and
`workspaceStorageStateSchema` accept these strings.

Use a `Map<string, string>` inferred from the existing labels. The
[ECMAScript Map.get algorithm](https://tc39.es/ecma262/2023/multipage/keyed-collections.html#sec-map.prototype.get)
looks up stored entries and returns `undefined` for missing keys, so all unknown
triggers use the existing Automatic label. The actual storage panel regressions
failed for the three prototype names before the fix. They also cover an ordinary
future name and all five existing labels; history results stay readable.

## Configuration review fields

Fixed: `rebaseMachineDraft` cast configuration objects to open records and built
its result with indexed assignments. A newer configuration's own `__proto__`
field disappeared through that object's inherited setter. An absent
`constructor` or `toString` field read a function from the prototype instead of
an absent value, so removing the field could adopt that function. The field-label
record also returned prototype objects/functions under its declared string type;
the editor renders conflict labels as React children.

Keep both input field dictionaries, the merged fields, and labels in typed maps.
Convert the final entries with
[Object.fromEntries](https://tc39.es/ecma262/2023/multipage/fundamental-objects.html#sec-object.fromentries),
which creates own data properties even for `__proto__`. The configuration kind
check and choice of complete typed inputs remain unchanged. Six adoption/conflict
regressions failed before the fix; removal cases also protect against inherited
values. Existing CPU/memory/desktop conflict and removal cases remain covered.

The upstream `divergentMachineFields` comparison also needs own field values:
an inherited function serialized like `null`, hiding the user's removal of a
null-valued field. Two concurrent-edit regressions failed after the initial
rebase fix and passed only after correcting this comparison and distinguishing
an absent value from `null`. The model tests passed 22 cases; typecheck, focused
oxlint, and `git diff --check` passed on Node 24.11.1.

## Machine validation error fields

Fixed: `validateMachine` asserted every string issue path was a displayed error
field and dropped issues whose path was empty. A retained future configuration
field produces a root `unrecognized_keys` issue under the strict submission
schema. The editor then called Save despite that invalid configuration. Invalid
IDs instead produced an `errors.id` value with no corresponding editor control
or alert, silently blocking submission.

Use a type guard for the fields the editor displays and route every other issue
to its existing form alert. Zod's [error documentation](https://zod.dev/error-customization)
defines structured issue paths, including empty paths for root errors. The
submission contract stays strict and retained configuration fields stay intact.
Two model regressions and one editor regression failed before the fix. The
editor regression checks both the visible alert and that Save does not run.

## Empty submission before configuration loads

Fixed: `configureMachines` derived an empty change list from an unloaded source
and an empty request, then asserted `snapshot.source` was `ApplicationSource`.
The promised successful result was actually `null`. Removing the last draft
sandbox in onboarding submits through this method, so the adapter cleared its
operation error despite never knowing the saved configuration.

Reject that no-op while the source is unavailable and tell the user to refresh
and retry. A loaded empty configuration still resolves without native changes.
The two regressions reproduced successful `null` results both before loading and
after the initial state read failed. The loaded-empty control remains covered.

## Optional connection removal

Fixed: the Computers settings section renders for an adapter with
`connectComputer`, but its Remove connection button assumed the independently
optional `removeComputer` callback existed. Its non-null assertion hid the
missing capability and an enabled button called `undefined`. The browser
preview explicitly supports partial action adapters.

Capture the removal callback, disable its button when absent, and guard the
event callback without an assertion. A missing-capability regression failed
before the fix. Existing tests exercise successful removal and failure/retry
with the callback present.

# Native bridge contracts (K-05, K-23)

## Source and decision

[Tauri 2 command error handling](https://v2.tauri.app/develop/calling-rust/#error-handling)
(accessed 2026-09-30) supports any serializable command error and demonstrates
returning a discriminant separately from its human message. Silo follows that
supported feature without adding a binding generator or a protocol subsystem.
The owner decision in [the design notes](../SiloUI-REVIEW-DESIGN-NOTES.md#k-23-typed-error-codes-across-the-native-bridge)
sets the seven closed snake-case codes.

`BridgeError { code, message }` crosses migrated Tauri commands. Runtime/gate
variants supply cancellation, busy, and duplicate classifications; arbitrary
strings map to `internal`. Snapshot retries use `update_in_progress`. The frontend
uses codes for update deferral, unsupported remote features, and lifecycle
cancellation, and displays message text even for an unknown code.

## Remote compatibility

Remote error replies retain `error: string` and add `code` and `message` beside
it. The wire encoder keeps the original update/unsupported values in `error` so
older controllers retain their recovery behavior, while current peers read the
code and human message. Typed dispatch, replay result storage, transport decoding,
and the migrated controller commands preserve the code. The protocol version stays unchanged because the field is additive.

Only the wire decoder recognizes exact older snapshot-update and unsupported
operation messages. No substring, suffix, or user-facing copy determines current
recovery behavior. Unknown remote codes become `internal`. Older dynamic
cancellation messages remain ordinary failures because those peers supply no
reliable cancellation discriminant. The legacy `call_remote` adapter deliberately
returns display text to commands outside this migration; `call_remote_typed`
preserves codes for migrated callers. Legacy strings supplied locally remain
ordinary errors.

The transfer worker already classifies cancellation from `BackupError` and
`GateError`, with a stage-specific detail (E-42), and runtime launch failures
already have a typed variant (D-17). This change keeps those decisions.

## Evidence and limits

Rust serializes application, remote snapshot, SSH access, network state, and
operation queue JSON. Frontend tests feed those files through the production Zod
parsers and assert that optional data survives tolerant parsing. See the
[fixture guide](../../app/SiloUI/src/test/contracts/README.md) for coverage and
regeneration. Rust and TypeScript also verify the error enum and error payloads.
Shared native mocks reject unhandled commands; teardown verification catches
unknown calls even when a production error path catches their rejection.

These checks exercise synthetic state and the wire contract. They do not launch
a packaged app, contact an SSH computer, or prove live VM health.

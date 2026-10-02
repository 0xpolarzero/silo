# Log credential exposure

Scope: retained sandbox logs and lifecycle diagnostics, using synthetic output
and temporary files. No app, VM, credential store, or live log was inspected.

## LOG-SECRETS-1: URL user information reaches logs and exports

The shared `log_text` filter returned URLs containing passwords or token-only
usernames unchanged. The production retained reader returned the synthetic
percent-encoded password in its serialized first page. URL detection now uses
the existing `reqwest::Url` parser's username/password accessors and hides the
whole line. Public URLs, email addresses, punctuation in credentials, and IPv6
hosts have regression coverage. Fixed and folded in `948c21cf`.

## LOG-SECRETS-2: Separated credential options reach logs and diagnostics

Commands such as `curl --user alice:password`, `login --password value`, and
`client --access_token value` contain neither a sensitive assignment nor URL
user information. The unchanged retained reader returned the synthetic token
in its first page. The shared filter now recognizes credential option words
and curl's `-u`; harmless options such as `--keyboard-layout` and `--user-agent`
remain readable. A lifecycle regression checks the persisted journal and both
activity and sandbox-failure IPC data. The retained-reader regression checks
first pages, pagination, context, and JSONL export.

## Verification

Before/after regressions executed extracted, unchanged production filter,
retained-reader, and export-writer functions against the shared compiled Rust
dependencies. Both defects failed before correction. The final extracted-source
run passed all 28 retained-reader/export tests and five filter tests. Native
Cargo test jobs use synthetic GitHub configuration and the shared target; they
were queued on its lock at fold time. Formatting, Node 24 typecheck, and lint
passed. Local evidence is ignored under
`app/SiloUI/src-tauri/target/verification/log-secrets/`.

These checks establish filtering at the display, diagnostic, and export
boundaries. Runtime files still contain raw guest output, and arbitrary secret
formats are outside this marker-based filter. Parser and curl references are
recorded in [Retained logs](../../SiloUI-LOGS.md).

# Runtime failure contract

D-16, D-17 and D-39 keep the typed runtime error until the command boundary.
`RuntimeError::Failed` records `exit_code` separately from runtime output;
`RuntimeError::Partial` retains the inner error and marks completed changes kept.
`failure_report` provides the shared category, one-line summary and filtered,
bounded diagnostic. Only the diagnostic includes the numeric process status.

| Payload | Summary | Details | Partial setup |
| --- | --- | --- | --- |
| `SiloProgressEvent` (`setup-failed`) | `message` | optional `diagnostic` | optional `partial: true` |
| Application workspace | optional `lifecycleFailure` | optional `lifecycleFailureDiagnostic` | not applicable |
| Application Activity | `title` and `detail` | optional `diagnostic` | optional `partial: true` |

Render the summary inline and details in the existing Details disclosure with
Copy. Never concatenate the diagnostic into a summary. Fields are optional for
older persisted records and remote owners. Native history splits the old
newline-separated lifecycle summary and diagnostic. Setup history reconstructs
safe messages from the saved category and retains the partial-change guidance.
The frontend parser preserves these fields; the UI package owns the disclosure
hookup (I-44).

Verification uses temporary stores and fake runtime children. It does not prove
live VM health or installed-app behavior.

`ScopedTokens` is host-only retirement material: it does not implement
`Serialize`, and `Debug` prints only its redacted count. The production
compile-time guard was checked by temporarily adding `Serialize`; compilation
failed with E0283 at that guard. The temporary derive was removed.

D-20 removes the native snapshot's legacy `preferences` and `backup`
presentation fields. The current local adapter supplies centralized settings
defaults and an empty legacy backup summary; the remote adapter also tolerates
the missing fields. Strict older snapshot adapters reject that payload, as the
before-fix regression demonstrated. This contract cleanup therefore carries a
minor changeset under the pre-1.0 release policy. Preferences and actual export
state continue to come from their respective stores. Legacy SSH entries retain
their configuration but report unavailable state rather than a guessed stop.

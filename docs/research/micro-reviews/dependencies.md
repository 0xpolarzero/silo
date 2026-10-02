# Dependencies micro-review

Scope: `app/SiloUI/src-tauri/src/dependencies.rs`.

Read-only source review. Checked the first, second, and third review reports for duplicates. No builds, tests, app launches, or source changes were performed.

## DEPENDENCIES-1 · P2 · Serial probe budgets exceed the UI report deadline

- **File:line:** `app/SiloUI/src-tauri/src/dependencies.rs:1133` (serial collection), with per-process deadlines at lines 18 and 433.
- **Trigger:** On macOS, each of the six signature verifications succeeds in 2.6 seconds. The two runtime signatures run serially at lines 845–850, and the four Git signatures run serially at lines 1005–1019. Their combined 15.6 seconds already exceeds the frontend watchdog, even before the OS, virtualization, and version probes. Every individual signature verification remains within its three-second native deadline.
- **Evidence:** `verify_macos_signature` delegates to the three-second `run_bounded` at lines 787–795. `collect` synchronously completes the system, virtualization, and runtime checks before starting Git checks, then returns one complete report. There is no collection deadline. `app/SiloUI/src/desktop/dependencies.ts:65–70` sets a 15,000 ms watchdog; lines 82–88 clear the active request and replace every row with a timeout; line 91 discards the subsequently returned report. The native path contains eleven serial process probes on a successful macOS run, with an aggregate per-process budget of 33 seconds.
- **Consequence:** A report containing successful checks is discarded, and onboarding presents every dependency as timed out. Retry repeats the failure when the same probe timings persist. Completed checks also disappear when a later check consumes the remaining UI budget.
- **Suggested fix:** Define and enforce a request-level deadline compatible with the frontend watchdog, allowing time to deliver the report. Pass the remaining budget into probes and preserve completed check results when that budget expires. Coordinate the frontend deadline with the native budget; independent checks can run concurrently if their isolation is preserved.
- **Regression test:** Inject a deterministic probe runner and clock into collection. Model six successful macOS signature probes taking 2.6 seconds each and fast successful version/host probes. Drive the dependency store watchdog with the resulting collection timing. Assert that the native report is delivered before abandonment, completed checks retain their results, and unfinished checks receive explicit timeout results. Also cover one late failing probe so its specific remediation is retained.

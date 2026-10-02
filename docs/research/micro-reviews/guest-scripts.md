# Guest scripts micro-review

Scope: shell and Python guest scripts under `app/SiloUI/src-tauri/guest/`, outside Rust `src/`. Reviewed account migration, directory listing, GitHub setup, desktop installation/lifecycle, accessibility, Selkies patching, and both LCU helpers. Read-only source review; no builds, tests, live guests, or app launches. Existing reports were searched and prior migration, stale-readiness, installer-publication, and computer-use output/lifetime findings excluded.

## GUEST-SCRIPTS-1 — P2 — Session recovery cannot recover while the supervisor survives

**Location:** `app/SiloUI/src-tauri/guest/desktop-service.py:766–768`, `:880–887`, `:603–614`, `:649–664`; `app/SiloUI/src-tauri/guest/silo-computer-use.py:429–445`.

**Trigger:** After the three session processes launch, a session child such as Xvfb exits while the supervisor remains alive. The supervisor enters `supervise_selkies_stream`, which checks the stream child and restart signals but never checks or reaps the session children. Even after exhausting streamer attempts it continues waiting under the same supervisor.

**Evidence:** `selkies_session_state` correctly returns `failed` when any recorded session process no longer matches. However, `start_selkies` returns immediately whenever `supervisor()` exists, without checking that session state. `wait_for_session(..., repair=True)` calls this same `start` operation three times for a failed session and then raises `desktop-session-not-running`. None of those recovery attempts relaunches a session process. This is a source-confirmed control-flow defect, not a live crash reproduction, and differs from the previously reported early return on a matching computer-use receipt.

**Consequence:** A failed desktop session stays failed despite the helper's explicit recovery attempts; invoking `start` returns success without restoring it. A full explicit desktop restart is required. Exited session children also remain unreaped while the stream supervision loop runs.

**Suggested fix:** Detect and reap session-child exits in the supervisor, stop the remaining owned session processes, and publish the failure. Make `start` handle a failed session through coordinated supervisor teardown and a fresh bounded session launch; preserve a healthy session during streamer-only recovery.

**Test that would catch it:** With deterministic child-process collaborators, launch all three session children, then make Xvfb exit while the supervisor and stream child survive. Run the existing `wait_for_session` repair path and require either a restored session or an explicit start failure that reflects an attempted recovery. Assert exited children are reaped and a healthy session is untouched by streamer restart.

## GUEST-SCRIPTS-2 — P2 — Selkies bypasses desktop log retention

**Location:** `app/SiloUI/src-tauri/guest/desktop-service.py:486–489`, `:536–627`, `:832–902`, `:1023–1036`, `:1090`.

**Trigger:** Run the Selkies desktop with session or streamer output that grows `/var/log/silo-desktop.log` beyond 1 MiB, including repeated streamer crashes and retries.

**Evidence:** Every Selkies session and streamer child appends stdout and stderr directly to `LOG`. The existing `trim_logs` function bounds that file to a 256 KiB tail once it exceeds 1 MiB, but its sole call is in the legacy Kasm supervision loop. `supervise_selkies` and both stream wait/retry loops never call it. The startup rotation at lines 1077–1079 is also confined to Kasm. Searching the guest image found no alternative log-rotation configuration. Source-confirmed; disk exhaustion was not exercised.

**Consequence:** Selkies logs have no application-enforced size bound across long sessions, retries, or desktop restarts. Continued output consumes the guest root disk and ultimately makes guest writes fail.

**Suggested fix:** Apply bounded retention periodically in the Selkies supervisor and during retry waits, or use an established rotation mechanism configured for this guest log. Account for the open append descriptors retained by all session children.

**Test that would catch it:** Use a disposable log and noisy fixture children through the Selkies supervision path. Cross the 1 MiB threshold, keep writing after retention, and assert the file returns to a bounded tail while children remain running; include retry-exhausted supervision and repeated restarts.

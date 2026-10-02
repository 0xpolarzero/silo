# Tauri configuration micro-review and fix loop

Scope: `app/SiloUI/src-tauri/tauri*.conf.json`, `capabilities/`, `Cargo.toml` features, `Info.plist`, and `Entitlements.plist`; caller checks needed to establish the configured permission boundary. The initial static review reported no defects. The follow-up below supersedes that result.

## TAURI-CONFIG-1: Settings events bypass the onboarding-draft boundary

**P2.** Locations before the fix: `app/SiloUI/src-tauri/capabilities/application-events.json:6`, `app/SiloUI/src-tauri/src/settings.rs:750–753`, and `app/SiloUI/src/desktop/settings.ts:38–42`.

**Trigger.** Main publishes a settings change while the status window's default `settings:changed` listener is registered. Tauri's JavaScript `listen` defaults to target `Any`; its locked 2.11.5 event dispatcher delivers targeted emissions to catch-all listeners. The publication sends an unredacted snapshot to `main`, followed by a redacted snapshot to `status`, under the same event name and revision.

**Consequence.** The status listener receives onboarding drafts despite `read_settings` explicitly redacting drafts for non-main callers. The main listener also receives the status snapshot, which can replace its recovery draft with null because equal revisions are accepted. This establishes an event-payload boundary failure and draft loss in memory; it does not establish leaked credentials or a disk deletion.

**Evidence.** The native regression subscribes through Tauri's real catch-all event API and calls Silo's real publication function with a recovery draft. The frontend regression delivers the public event to the real desktop settings store and checks that its draft survives while an authorized read is pending. The frontend regression failed before the fix with `Received: null`. The native regression passed against the fixed event emitter; its original queued invocation was still awaiting the Cargo lock when implementation changed.

**Suggested fix.** Publish one redacted snapshot to all listeners. Main retrieves its private draft through the existing caller-checked `read_settings` command. Keep status reads and event payloads public; window labels and event names do not confer confidentiality.

**Regression.** Assert every settings event payload omits the draft without modifying the stored snapshot, and main preserves recovery data while refreshing through its authorized command. Retain status event ordering and subscription recovery tests.

**Primary sources.** [Tauri event system](https://v2.tauri.app/develop/calling-frontend/#event-system) documents the absence of fine-grained event capabilities. Version-specific behavior was checked in the cached locked `tauri-2.11.5/src/event/listener.rs` (`match_any_or_filter`, `emit_js_filter`) and installed `@tauri-apps/api/event.js` (`listen`'s `Any` default). [Capabilities](https://v2.tauri.app/security/capabilities/) and [CSP](https://v2.tauri.app/security/csp/) provide the configuration contracts checked in the rest of this scope.

## Verification

Initial checks in the isolated worktree: command-manifest checker passed; desktop build routing tests passed 8/8; Linux tool/config overlay tests passed 2/2. Native tests use synthetic GitHub values, the shared `/tmp/silo-codex-target`, Dev identity, and an override omitting unavailable packaged resource inputs. No app, installed bundle, real HOME, Keychain, or VM was exercised. Native mock-runtime tests do not prove packaged webview behavior.

Verification after implementation: the new frontend regression failed before the fix on the null draft, then settings transport tests passed 20/20 and related tests passed 47/47. After incorporating current integration and preserving both sides of a test insertion conflict, the five related frontend suites passed 55/55. Typecheck, lint of the touched frontend files, Rust formatting, and whitespace checks passed on the reconciled tree. A test-only TypeScript intersection was corrected after typecheck rejected it.

The focused native command completed successfully after waiting for the shared target: `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked settings_events_never_expose_onboarding_drafts` passed 1/1 with the synthetic configuration and resource override described above. It emitted three existing unused-variable/dead-code warnings. The superseded permission-test request was stopped after verifying its PID and worktree. Native evidence is in `/tmp/silo-codex-target/verification/tauri-config/native-events.log`; frontend before/after and integration logs are beside it. Integration changes did not alter the event-emission helper or its native regression.

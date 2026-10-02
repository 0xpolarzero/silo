# Silo Tauri boundary security review, 2026-10-02

Review in progress. This ledger records new findings as SEC-01 onward and excludes findings already documented in the two earlier reports.

## Scope and evidence

Starting revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-ipc-security`. Read the first review (R-01–R-26) and second review (R-27–R-37, historical R-38) from the main checkout before auditing. Those reports remain historical evidence; this report does not copy them or claim their findings remain open.

Review targets: all `#[tauri::command]` entry points and their registered capabilities; caller and argument validation; host and guest path traversal and symlinks; msb, SSH, Git, editor and browser arguments; webview CSP and navigation; deep links and URL handling; transfers; secrets in logs and IPC.

Threat model: guest files and guest-served web content are untrusted. Local main/status UI has explicit native authority; that authority still needs typed validation and must not leak into guest webviews. A compromised same-user host process can already modify the app's private files, so a filesystem claim must identify a weaker attacker or accidental data-loss consequence. Source confirmation is distinguished from executed fixture evidence.

No app launch, real VM, credential store, production HOME, runtime preparation, or live network integration is authorized by this review. Native tests use synthetic GitHub configuration and the shared `/tmp/silo-codex-target`; fixtures use temporary data. No dependency advisory assessment is claimed.

## New findings

### SEC-01 Raw search input leaks through log-export coverage metadata

**P2. Fixed and folded in `b67c6b3f`; native regression and export suite passed.** Location: [log_export.rs](../app/SiloUI/src-tauri/src/log_export.rs), `write_requests` and `export_workspace_logs`.

**Trigger.** Search logs for a token or private text, then export the filtered logs. The first-page coverage record serializes the complete `Query`, including its raw `query` string. This happens even when the backend returns zero entries. Log-entry redaction never touches that metadata.

**Evidence.** Added `export_hides_search_text_but_preserves_filtering_and_coverage` against the actual export writer with synthetic search text and an empty page. The unchanged writer fails at the no-search-text-in-output assertion: **0 passed, 1 failed**, 1,342 filtered out. The regression also covers arbitrary private search text, verifies the query collaborator receives the original filter, and checks sandbox/source/count coverage. No credential store or real log was read.

**Consequence.** Sharing the JSONL file discloses the typed search input, including credentials the user was checking for, independently of whether any log entry is sensitive. This is separate from R-27: that report concerns record-body PEM redaction, while this defect writes caller input directly into export metadata.

**Correction.** Preserve the original request for querying and replace only the exported search text with an explicit `[Search text hidden]` marker. Hide all search text, since a marker-based token detector would miss arbitrary credentials and personal text. Keep source, sandbox identity, time coverage, match counts, and ordinary log rows.

**Acceptance.** The export contains neither synthetic input, including for zero matches, and the backend still receives the unchanged filter. Existing pagination, cancellation, atomic publication, and failed-page tests must pass. This repair does not establish universal log redaction or resolve R-27.

**Verification.** `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked log_export::tests` passed **7/7** with synthetic configuration and the shared target. Formatting and frontend typecheck passed; frontend lint passed with 12 existing warnings. An additional extracted-source check ran the same seven export tests successfully; its initial dependency-artifact mismatch was fixture setup, not a product failure. Exact native before/after logs are ignored local evidence in `app/SiloUI/src-tauri/target/verification/pass3-ipc-security/`.

### SEC-02 Editor URIs reinterpret literal guest folder names

**P2. Fixed; native regression and editor suite passed.** Location: [editor.rs](../app/SiloUI/src-tauri/src/editor.rs), `remote_uri`, `editor_launch` and `vscode_workspace`.

**Trigger.** Select a guest folder whose literal name contains percent escapes, for example `/workspace/a%2Fb` or `/workspace/%2e%2e/outside`. The path validator accepts these legitimate filesystem names, and the local guest probe checks that exact path as an argument. `Url::set_path` then preserves pre-encoded bytes and normalizes encoded dot segments instead of encoding the raw filename.

**Evidence.** The native regression `editor_handoff_keeps_percent_names_and_encoded_dot_segments_literal` failed on the unchanged implementation: **0 passed, 1 failed**, 1,361 filtered out. Its first case produces `/workspace/a%2Fb` instead of `/workspace/a%252Fb`. A disposable probe against the locked URL library also produced `/outside` from `/workspace/%2e%2e/outside`. The regression covers both VS Code and Zed URI formats, the actual saved `.code-workspace` document, mixed-case dot encoding, a literal percent sign, and rejection of newline, carriage-return and tab-containing names. No editor or guest was launched.

**Consequence.** The editor receives a different guest path from the selected and checked folder; encoded dot segments can remove the `/workspace` prefix altogether. This is a guest-path handoff defect. No host filesystem escape, shell execution, or live editor exploit is established. Guest symlinks and the guest working account's existing access are separate from URI identity.

**Correction.** Validate the raw path and use the supported `Url::path_segments_mut().clear().extend(...)` API with raw slash-separated components. This encodes literal percent signs before constructing the URI. Reject ASCII control characters with an explicit error: the locked URL parser strips tab/newline characters even through the path-segment API. A disposable test of the initial percent-only correction failed on a newline name; that failure narrowed the final correction. A bespoke encoder and banning valid percent-containing filenames are unnecessary. The locked [URL API documents that `set_path` preserves encoded input](https://docs.rs/url/2.5.8/url/struct.Url.html#method.set_path); [path-segment insertion encodes literal percent signs](https://docs.rs/url/2.5.8/url/struct.PathSegmentsMut.html#method.extend).

**Acceptance.** Both editor formats and the saved workspace must preserve percent-containing names as encoded literal components and reject control-character names before handoff. Existing SSH quoting, config/key permissions, symlink rejection, launch and workspace-setting tests must still pass. The native editor suite passed **32 tests**, with **1 live-VM test ignored**. The initial URL-only correction failed its newline probe; the final extracted-source probe passed **2/2**. Formatting, frontend typecheck and lint passed. Lint has no warnings at this revision; native compilation retains three existing warnings. Before/after native logs and both probe results remain in the ignored local evidence directory.

## Coverage and verification

Capabilities and registered-command inventory collected. Detailed review and focused reproductions are in progress. Existing findings excluded from new IDs include token-ledger retirement and replacement (R-07/R-08/R-19), tunnel readiness/lifetime (R-09/R-10), working-account migration links (R-24), and split-record PEM redaction (R-27).

# Silo Tauri boundary security review, 2026-10-02

Review in progress. This ledger records new findings as SEC-01 onward and excludes findings already documented in the two earlier reports.

## Scope and evidence

Starting revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-ipc-security`. Read the first review (R-01–R-26) and second review (R-27–R-37, historical R-38) from the main checkout before auditing. Those reports remain historical evidence; this report does not copy them or claim their findings remain open.

Review targets: all `#[tauri::command]` entry points and their registered capabilities; caller and argument validation; host and guest path traversal and symlinks; msb, SSH, Git, editor and browser arguments; webview CSP and navigation; deep links and URL handling; transfers; secrets in logs and IPC.

Threat model: guest files and guest-served web content are untrusted. Local main/status UI has explicit native authority; that authority still needs typed validation and must not leak into guest webviews. A compromised same-user host process can already modify the app's private files, so a filesystem claim must identify a weaker attacker or accidental data-loss consequence. Source confirmation is distinguished from executed fixture evidence.

No app launch, real VM, credential store, production HOME, runtime preparation, or live network integration is authorized by this review. Native tests use synthetic GitHub configuration and the shared `/tmp/silo-codex-target`; fixtures use temporary data. No dependency advisory assessment is claimed.

## New findings

No new finding confirmed yet. Pending investigation is not evidence of a vulnerability.

## Coverage and verification

Capabilities and registered-command inventory collected. Detailed review and focused reproductions are in progress. Existing findings excluded from new IDs include token-ledger retirement and replacement (R-07/R-08/R-19), tunnel readiness/lifetime (R-09/R-10), working-account migration links (R-24), and split-record PEM redaction (R-27).

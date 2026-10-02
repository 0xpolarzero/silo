# Silo third review pass: guest and SSH bridge, 2026-10-02

Review in progress. This ledger records new findings only; R-01 through R-37 and historical R-38 in the two existing reports were read before review and are excluded from the new finding count.

Initial revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-guest-bridge`. Scope: guest image construction, provisioning and shell helpers, `silo-remote` installation/protocol/authentication/upgrade, and the vendored Rust updater patch. Focus: quoting and injection, host/guest trust, partial failures, idempotency, and older bridge versions.

No installed app, live VM, production HOME, Keychain, or remote computer is used. Tests use temporary fixtures. Source evidence and executed regressions are distinguished below. Each confirmed finding will include ID GB-01 onward, priority, trigger, evidence, consequence, correction, and a rejecting test.

## Findings

No new finding confirmed yet.

## Verification

- Read `/tmp/silo-codex-common.md`, worktree `AGENTS.md`, and both existing reports from the main checkout without modifying them.
- Report committed and folded before continuing the review; subsequent findings and fixes will be committed and folded separately.

## Review boundaries

Existing guest migration destination-symlink traversal (R-24), stale computer-use readiness (R-11), remote timeout (R-25), checkpoint restore policy (R-28/R-29), tunnel readiness/lifetime (R-09/R-10), and failed Linux restart ownership (R-35) are prior findings, not new GB entries.

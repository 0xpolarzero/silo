# Silo third review pass: guest and SSH bridge, 2026-10-02

Review in progress. This ledger records new findings only; R-01 through R-37 and historical R-38 in the two existing reports were read before review and are excluded from the new finding count.

Initial revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-guest-bridge`. Scope: guest image construction, provisioning and shell helpers, `silo-remote` installation/protocol/authentication/upgrade, and the vendored Rust updater patch. Focus: quoting and injection, host/guest trust, partial failures, idempotency, and older bridge versions.

No installed app, live VM, production HOME, Keychain, or remote computer is used. Tests use temporary fixtures. Source evidence and executed regressions are distinguished below. Each confirmed finding will include ID GB-01 onward, priority, trigger, evidence, consequence, correction, and a rejecting test.

## Findings

### GB-01 Existing SSH permissions survive key installation

**Priority:** P2. **Status:** fix in progress.

**Trigger:** Run Silo's key setup against an account whose existing `.ssh` directory or `authorized_keys` file is writable by another user.

**Evidence:** `src-tauri/src/remote.rs`, `INSTALL_PUBLIC_KEY`, sets `umask 077` but uses `mkdir -p` and `touch` on existing paths. Neither changes existing modes. Executing the exact script twice with a temporary HOME returned success and appended the key once, but retained directory mode `0777` and file mode `0666`; the accepting-mode assertions failed. Native regression extends the existing shell installation fixture with those initial modes. The native run is waiting for the shared Cargo target lock.

**Consequence:** Ordinary OpenSSH `StrictModes` rejects the installed key; repeating Silo's offered setup command cannot repair it. With `StrictModes` disabled, the writable authorization file remains exposed to other local users. This review did not launch sshd. The [OpenSSH authorized-keys permissions contract](https://man.openbsd.org/sshd.8) explicitly rejects these writable paths under StrictModes.

**Correction:** Require private modes on the managed SSH directory/file before adding the key, and propagate a failed chmod through the shell's success status. Keep existing keys, final-newline handling, and repeat-install behavior.

**Rejecting test:** Seed `.ssh` with `0777`, `authorized_keys` with `0666`, and an unrelated unterminated key; run the production script twice. Require `0700`/`0600`, unchanged unrelated bytes, one installed line, and successful execution through supported login shells.

### GB-02 Failed older-key restriction is hidden by a successful handshake

**Priority:** P2. **Status:** open; correction needs an explicit migration-result contract.

**Trigger:** Upgrade an owner with an older unrestricted Silo key, then handshake when rewriting `authorized_keys` fails, or when the file is symlink-managed.

**Evidence:** `src-tauri/src/remote.rs`, `restrict_authorized_keys_file`, deliberately returns `Ok(false)` for symlinked files; its existing fixture proves the unrestricted target bytes remain unchanged. `execute("handshake")` catches rewrite errors with `eprintln!`, ignores the boolean result, and returns success. `handle` then publishes normal version/capabilities. The error case and handshake behavior are source-confirmed, not a live SSH upgrade reproduction.

**Consequence:** The controller reports a working connection while its dedicated management key retains unrestricted shell authority from the old installation. Logging on the owner does not tell the controller that migration failed. Restricting a key also affects subsequent SSH authentications, so success must not promise retroactive restriction of the current session. No stolen key or shell compromise was demonstrated.

**Correction:** Report key-migration state in the handshake and surface failure with a repair path. Distinguish already restricted, changed, absent, externally managed, and failed; `false` currently conflates these states. Preserve externally managed files. Do not reject legitimate connections made with an unrelated personal key merely because no Silo line exists.

**Rejecting test:** Handshake through the production dispatch seam with an old unrestricted line, a denied replacement, and a symlink-managed file. Assert the controller receives an actionable incomplete-upgrade result and the originals remain intact; after repair, a new authentication must use the restricted key. Include already-restricted and unrelated-personal-key controls.

### GB-03 Management keys permit remote forwarding outside bridge admission

**Priority:** P2. **Status:** open; no small correct per-key fix identified.

**Trigger:** A holder of the dedicated Silo key requests `ssh -N -R` on an owner whose sshd permits remote forwarding. The holder need not invoke the bridge.

**Evidence:** `authorized_key_options` in `src-tauri/src/remote.rs` emits `restrict,port-forwarding,permitopen="127.0.0.1:*",command=...`. The [OpenSSH key-option contract](https://man.openbsd.org/sshd.8) defines `port-forwarding` as re-enabling forwarding, `permitopen` as a local-forward target limit, and `permitlisten` as the separate remote-forward listener limit. No `permitlisten` restriction exists here. [OpenSSH 9.9p2's parser](https://github.com/openssh/openssh-portable/blob/V_9_9_P2/auth-options.c) rejects `permitlisten="none"` as an invalid port, so copying the similarly named sshd setting into this key is not a correct fix. Source-confirmed; no sshd session was launched.

**Consequence:** The key can create owner-side TCP listeners and relay controller-selected services independently of enabled remote management, host identity checks, and Silo's operation admission. Default GatewayPorts constrains listener exposure to loopback; broader exposure depends on owner sshd configuration. This is excess listener authority, not evidence of shell access or host escape. Local loopback forwarding is an intentional capability and is not itself counted as a defect.

**Correction:** Decide and enforce the forwarding-direction policy using supported OpenSSH controls. Evaluate `AllowTcpForwarding local` in an owner-managed Match policy or an existing transport that avoids per-key TCP forwarding; document deployment requirements. Do not remove forwarding without preserving Silo's desktop/published-port behavior, or claim a reserved-port allowlist forbids all remote listeners.

**Rejecting test:** In disposable sshd fixtures, the dedicated key must still complete a bridge request and authorized local loopback forwarding, while `-R` and remote dynamic forwarding fail with no listener. Repeat while remote management is disabled and with GatewayPorts settings that would otherwise allow broader exposure.

## Verification

- Read `/tmp/silo-codex-common.md`, worktree `AGENTS.md`, and both existing reports from the main checkout without modifying them.
- Report committed and folded before continuing the review; subsequent findings and fixes will be committed and folded separately.

## Review boundaries

Existing guest migration destination-symlink traversal (R-24), stale computer-use readiness (R-11), remote timeout (R-25), checkpoint restore policy (R-28/R-29), tunnel readiness/lifetime (R-09/R-10), and failed Linux restart ownership (R-35) are prior findings, not new GB entries.

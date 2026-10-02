# Silo third review pass: guest and SSH bridge, 2026-10-02

This pass found three new P2 defects in SSH key setup, key upgrades, and forwarding authority. This ledger records new findings only; R-01 through R-37 and historical R-38 in the two existing reports were read before review and are excluded from the new finding count.

Initial review source confirmation: `071ca883d4298e160de92e369b916688a7b4feb7`. Follow-up fixes and verification appear below.

Initial revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-guest-bridge`. Scope: guest image construction, provisioning and shell helpers, `silo-remote` installation/protocol/authentication/upgrade, and the vendored Rust updater patch. Focus: quoting and injection, host/guest trust, partial failures, idempotency, and older bridge versions.

No installed app, live VM, production HOME, Keychain, or remote computer is used. Tests use temporary fixtures. Source evidence and executed regressions are distinguished below. Each finding includes priority, trigger, evidence, consequence, correction, and a rejecting test. All three findings now have fixes. GB-03 reuses the guest transport already used by desktops and requires both computers to update.

## Findings

### GB-01 Existing SSH permissions survive key installation

**Priority:** P2. **Status:** fixed and folded, commit `635f1d4d` (`fix(remote): repair SSH permissions before installing management key`).

**Trigger:** Run Silo's key setup against an account whose existing `.ssh` directory or `authorized_keys` file is writable by another user.

**Evidence:** `src-tauri/src/remote.rs`, `INSTALL_PUBLIC_KEY`, sets `umask 077` but uses `mkdir -p` and `touch` on existing paths. Neither changes existing modes. Executing the exact script twice with a temporary HOME returned success and appended the key once, but retained directory mode `0777` and file mode `0666`; the accepting-mode assertions failed. The actual native regression extended the existing shell installation fixture with those initial modes and failed with actual `511` (`0777`) versus expected `448` (`0700`). An extracted copy of the same Rust fixture also failed before the fix and passed after it. A second new regression injects chmod failure and rejects success or an appended key; its extracted production test failed against the old script and passed against the fix.

**Consequence:** Ordinary OpenSSH `StrictModes` rejects the installed key; repeating Silo's offered setup command cannot repair it. With `StrictModes` disabled, the writable authorization file remains exposed to other local users. This review did not launch sshd. The [OpenSSH authorized-keys permissions contract](https://man.openbsd.org/sshd.8) explicitly rejects these writable paths under StrictModes.

**Correction:** Require private modes on the managed SSH directory/file before adding the key, and propagate a failed chmod through the shell's success status. Keep existing keys, final-newline handling, and repeat-install behavior.

**Rejecting test:** Seed `.ssh` with `0777`, `authorized_keys` with `0666`, and an unrelated unterminated key; run the production script twice. Require `0700`/`0600`, unchanged unrelated bytes, one installed line, and successful execution through supported login shells. A failed permission change must fail the installer without appending a key.

### GB-02 Failed older-key restriction is hidden by a successful handshake

**Priority:** P2. **Status:** fixed and folded, commit `fc014339`; handshake errors now reach the controller.

**Trigger:** Upgrade an owner with an older unrestricted Silo key, then handshake when rewriting `authorized_keys` fails, or when the file is symlink-managed.

**Evidence:** `src-tauri/src/remote.rs`, `restrict_authorized_keys_file`, deliberately returns `Ok(false)` for symlinked files; its existing fixture proves the unrestricted target bytes remain unchanged. `execute("handshake")` catches rewrite errors with `eprintln!`, ignores the boolean result, and returns success. `handle` then publishes normal version/capabilities. The error case and handshake behavior are source-confirmed, not a live SSH upgrade reproduction.

**Consequence:** The controller reports a working connection while its dedicated management key retains unrestricted shell authority from the old installation. Logging on the owner does not tell the controller that migration failed. Restricting a key also affects subsequent SSH authentications, so success must not promise retroactive restriction of the current session. No stolen key or shell compromise was demonstrated.

**Correction:** Report key-migration state in the handshake and surface failure with a repair path. Distinguish already restricted, changed, absent, externally managed, and failed; `false` currently conflates these states. Preserve externally managed files. Do not reject legitimate connections made with an unrelated personal key merely because no Silo line exists.

**Rejecting test:** Handshake through the production dispatch seam with an old unrestricted line, a denied replacement, and a symlink-managed file. Assert the controller receives an actionable incomplete-upgrade result and the originals remain intact; after repair, a new authentication must use the restricted key. Include already-restricted and unrelated-personal-key controls.

### GB-03 Management keys permit remote and Unix-socket forwarding outside bridge admission

**Priority:** P2. **Status:** fixed in this commit; owner forwarding is disabled and published ports use pinned guest SSH.

**Trigger:** A holder of the dedicated Silo key requests `ssh -N -R` on an owner whose sshd permits remote forwarding. The holder need not invoke the bridge. With the default StreamLocal policy, the key can also request local forwarding to an owner Unix socket through `ssh -N -L local-port:/owner/socket`.

**Evidence:** `authorized_key_options` in `src-tauri/src/remote.rs` emits `restrict,port-forwarding,permitopen="127.0.0.1:*",command=...`. The [OpenSSH key-option contract](https://man.openbsd.org/sshd.8) defines `port-forwarding` as re-enabling forwarding, `permitopen` as a local-forward target limit, and `permitlisten` as the separate remote-forward listener limit. No `permitlisten` restriction exists here. [OpenSSH 9.9p2's parser](https://github.com/openssh/openssh-portable/blob/V_9_9_P2/auth-options.c) rejects `permitlisten="none"` as an invalid port, so copying the similarly named sshd setting into this key is not a correct fix. [OpenSSH 9.9p2's direct-streamlocal handler](https://github.com/openssh/openssh-portable/blob/V_9_9_P2/serverloop.c#L412-L451) checks the forwarding flag and connects to the requested filesystem path without the TCP permitopen allowlist. [AllowStreamLocalForwarding](https://man.openbsd.org/sshd_config#AllowStreamLocalForwarding) defaults to yes. Source-confirmed; no sshd session was launched.

**Consequence:** The key can create owner-side TCP listeners and relay controller-selected services independently of enabled remote management, host identity checks, and Silo's operation admission. Default GatewayPorts constrains listener exposure to loopback; broader exposure depends on owner sshd configuration. Unix-socket forwarding additionally reaches account-accessible host services outside the loopback TCP allowance, such as a container daemon socket; socket filesystem permissions still apply. This is excess transport authority, not a demonstrated service compromise, shell access, or host escape. Local loopback forwarding is an intentional capability and is not itself counted as a defect.

**Correction:** Decide and enforce the forwarding-direction policy using supported OpenSSH controls. Evaluate `AllowTcpForwarding local` plus `AllowStreamLocalForwarding no` in an owner-managed Match policy or an existing transport that avoids per-key TCP forwarding; document deployment requirements. Do not remove forwarding without preserving Silo's desktop/published-port behavior, or claim a reserved-port allowlist forbids all remote listeners.

**Rejecting test:** In disposable sshd fixtures, the dedicated key must still complete a bridge request and authorized local loopback forwarding, while `-R`, remote dynamic forwarding, and local/remote Unix-socket forwarding fail with no listener or bytes delivered to a sentinel Unix socket. Repeat while remote management is disabled and with GatewayPorts settings that would otherwise allow broader exposure.

## Verification

All executions used fixture data. No bundle was built, launched, or inspected. Checks ran while integration advanced: the guest recipe/account/patcher and frontend checks precede inherited integration changes; those counts are not a claim that every later merged file was retested. The bridge group includes the completed GB-01 fix and chmod-failure test. Cargo used `+1.94.0`, `/tmp/silo-codex-target`, and explicit synthetic test-only GitHub configuration. Node used `24.11.1`. Existing prepared runtime resources were symlinked inside ignored worktree directories; runtime preparation did not run. The first native attempt stopped at missing generated resources before tests; its log is retained separately.

| Check | Result |
| --- | --- |
| Native GB-01 regression before fix | Failed as expected: 0 passed, 1 failed |
| Extracted real Rust installation fixture, before/after | Failed before, passed after |
| Extracted real Rust chmod-failure regression, before/after | Failed before, passed after |
| Fixed installation fixture across installed shells | Passed: sh, bash, zsh, dash, ksh, csh, tcsh; fish/nu unavailable |
| `cargo ... test --locked remote::` | 52 passed, including both GB-01 regressions and the existing key-upgrade fixtures |
| `cargo ... test --locked -p tauri-plugin-updater atomic_install -- --test-threads=1` | 5 passed, 1 subprocess-only test ignored; macOS only |
| `python3 -m unittest discover -s app/SiloUI/scripts -p 'test_desktop_recipe.py'` | 20 passed |
| Same discovery, `test_working_account.py` | 5 passed |
| Same discovery, `test_selkies_client_patch.py` | 4 passed |
| `node --test app/SiloUI/scripts/build-guest-image.test.mjs` | 8 passed, 11 container/live cases skipped |
| `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` | Passed after formatting the added assertion |
| `npm --prefix app/SiloUI run typecheck` | Passed |
| `npm --prefix app/SiloUI run lint` | Passed with 12 existing warnings |
| `git diff --check` | Passed |

Local diagnostic sources and exact failing/passing output are retained under ignored `app/SiloUI/src-tauri/target/verification/guest-bridge-pass3/`. The committed native regressions are the maintained coverage. These results do not qualify live SSH authentication, two-computer upgrades, real guest health, or Linux updater behavior.

- Read `/tmp/silo-codex-common.md`, worktree `AGENTS.md`, and both existing reports from the main checkout without modifying them.
- Report opened and folded at `c9820305`; findings folded at `56980ace` and `47498e0e`; GB-01 fix folded at `635f1d4d`. No application version or release state was changed.

## Review boundaries

Existing guest migration destination-symlink traversal (R-24), stale computer-use readiness (R-11), remote timeout (R-25), checkpoint restore policy (R-28/R-29), tunnel readiness/lifetime (R-09/R-10), and failed Linux restart ownership (R-35) are prior findings, not new GB entries.


Reproducible native commands, from the repository root:

```sh
CARGO_TARGET_DIR=/tmp/silo-codex-target \
SILO_GITHUB_APP_SLUG=silo-ci-test SILO_GITHUB_CLIENT_ID=test-client \
SILO_GITHUB_CLIENT_SECRET=test-secret \
  cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked remote::

CARGO_TARGET_DIR=/tmp/silo-codex-target \
SILO_GITHUB_APP_SLUG=silo-ci-test SILO_GITHUB_CLIENT_ID=test-client \
SILO_GITHUB_CLIENT_SECRET=test-secret \
  cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked \
  -p tauri-plugin-updater atomic_install -- --test-threads=1
```

GB-01 extends `remote::setup_tests::public_key_install_preserves_existing_unterminated_line_and_is_idempotent` and its cross-shell helper, and adds `public_key_install_fails_before_appending_when_permission_repair_fails`. The patch changeset is `app/SiloUI/.changeset/remote-key-permissions.md`.

## Coverage and limits

- Guest image review covered the Dockerfile, image build/verification scripts, staging, and Rust digest/size validation and local import. Fixed hashes and bounded unpacking remain intact. Container builds and real imports were excluded by the shared instructions.
- Guest provisioning review covered working-account account/ownership transitions, desktop recipe retries and locks, lifecycle process identity, Git credential-helper input handling, computer-use installation/archive extraction, and the Selkies patcher. Guest root and passwordless guest sudo are intentional privileges; they do not alone establish a host escape. Prior migration/readiness defects were excluded from this ledger.
- Bridge review covered address validation, shell argument construction, public-key input, installation and repointing, key restrictions and upgrade, framed replies/version rejection, local socket admission, and guest-stream routing. Public-key comments are not evaluated as shell source; the literal-input fixture remains covered. Protocol version mismatch fails closed; this is not a promise of interoperability with protocol 1.
- Vendor review covered `SILO-PATCH.md`, installer delegation, same-filesystem staging, archive root/type checks, directory swap/rename, synchronization, and interruption/cleanup tests. New guest/vendor defects were not confirmed in this pass. Linux AppImage replacement and actual signed application launches remain unqualified.

Next action: finish the focused native check and continue the guest/vendor failure-path review.

## Follow-up fix loop

GB-02: the production migration helper now rejects an externally managed file only when it retains the calling controller's known unrestricted Silo line. Missing keys, unrelated personal keys, and already restricted lines remain valid. Failed replacement reaches the normal bridge error reply with a repair instruction; managed targets remain unchanged. The new `handshake_reports_failed_key_upgrade_and_preserves_managed_files` fixture failed before the fix (`Ok(Null)` instead of an error), then passed for symlink management, denied replacement, repair/retry, already restricted, absent, and no-key cases. The fixture harness extracts the production functions and maintained tests, uses shared cached Rust dependencies, and supplies only channel/lock/error wrappers; it is not a live sshd test. Restriction applies to subsequent authentications, not the already authenticated upgrade session.

GB-03: `restrict,command=...` disables owner forwarding without relying on an invalid `permitlisten` option. Published ports reuse the existing guest SSH identity/configuration and admitted `guest.ssh` bridge stream; desktops already use it. Owner publication endpoints still drive restart invalidation, while the tunnel reaches the original guest port at the guest interface address. Protocol 3 fails older peers before migration; the matching handshake rewrites both exact legacy Silo line forms and remains idempotent. Personal/custom lines remain untouched. The new legacy migration regression and tightened installation contract both failed before the fix; six production key fixtures passed after it. Real system `ssh -G` resolves the private config, pinned identity/host-key settings, bridge ProxyCommand, and guest destination without opening a connection. The address fixtures cover IPv4, IPv6 fallback, unavailable routes, and rejection of shell text. The mocked route socket exposes no send method. The opt-in `test_remote_key_restrictions.py` fixture runs an unprivileged loopback sshd with disposable host/client keys, private config/known-hosts files, a temporary HOME, and `/bin/cat` replacing only the forced app command. It failed against the old production option template (allowed `-R` kept running), then passed against the fix: forced command bytes survive; remote TCP, remote dynamic, remote Unix-socket, and local TCP/Unix-socket forwarding are denied even with `GatewayPorts yes`, and fixture sentinels receive no connection. No real app or VM was launched. The test exercises OpenSSH authorization, not guest health or live two-computer upgrade. The transport choice and primary-source basis are recorded in [remote computers](SiloUI-REMOTE-COMPUTERS.md).

Follow-up checks before this commit: six extracted production key tests, two extracted command tests (including actual `ssh -G`), two extracted guest-address tests, and one opt-in local sshd test passed. `fmt --check`, typecheck, lint, and `git diff --check` passed. The first full native attempt waited on the shared Cargo lock, then stopped at an inherited `desktop_proxy.rs` test call missing its new deadline argument. Integration already contains that correction; the next synchronization and focused rerun will verify it. No separate Cargo target was created. The opt-in sshd command is `SILO_TEST_LOCAL_SSHD=1 python3 -m unittest discover -s app/SiloUI/scripts -p test_remote_key_restrictions.py`.

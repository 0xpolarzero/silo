# Secrets

Silo stores general secret values in the host credential store (macOS Keychain or
Linux Secret Service). `secrets.json` contains names, immutable value references,
VM assignments, allowed hosts, pending updates, safe failures, and bounded activity
history. Values are never returned in application snapshots. The editor sends a
value only when adding or replacing one, then discards its draft on successful save.

The credential store is read once per session, including caching denied access;
only an explicit save/delete/retry retries a failed store operation. There is no
plaintext fallback. A value is stored before its reference is published. Superseded
values are pruned after reconciliation. A deletion remains a tombstone until live
revocation and credential-store deletion complete, so a failed removal is retryable.

MicroSandbox receives host environment source references, not inline stored values.
The guest sees `$MSB_NAME` through its named environment variable. Existing values
and domain restrictions update live; adding a new variable on a running VM waits
for the next boot. Silo never restarts a VM implicitly. Runtime configuration is
checked after updates, including source reference, allowed hosts, placeholder, and
TLS requirement. The bundled runtime patch closes active proxy connections after
secret policy changes. Already delivered requests cannot be recalled.

Every boot resolves the current desired secret configuration; unavailable required
credentials block startup rather than restoring old material. Start completion
clears pending state only when the desired revision still matches. Secret and
GitHub updates share the existing runtime locks and preserve each other's config.

## Boundary

This mechanism supports credentials transmitted in proxied HTTPS requests. It does
not support private keys that a guest application needs for local signing. Allowed
servers receive the real value; a server that reflects it can reveal it to the
guest. Restrict allowed domains to trusted services. The existing `*` control
requires explicit acknowledgement that any HTTPS server could receive the value.
Guest output may contain sensitive user data; generic logging is not a guarantee
of redacting arbitrary data echoed by external services.

Silo backup archives do not include the host credential store. A restored VM must
use the host's current secret assignments, not recover secret values from its disk.

## Sources

- [MicroSandbox placeholder substitution](https://microsandbox.dev/blog/sandboxes-that-lie-about-their-secrets)
- [Official Rust SDK modification API](https://github.com/superradcompany/microsandbox/blob/main/docs/sdk/rust/sandbox.mdx)
- Pinned source: `5eca4de8bf233e57f114140f8c076ea8c96f21ab`,
  `sdk/rust/lib/sandbox/modify.rs` and `crates/cli/lib/commands/modify.rs`.
- Silo's checked-in runtime patch contains policy-change connection cancellation.

## Manual checks

Use disposable values and VMs. Never use a real credential for an echo-service test.

1. Add a secret to a stopped VM; verify its name and domains, then relaunch Silo.
2. Start the VM; inspect its environment and durable runtime config. Only the
   placeholder and host source reference should appear.
3. Send an HTTPS request to an allowed test server and verify substitution there;
   send the placeholder to a different server and verify blocking.
4. Rotate the value, change domains, and remove access while the VM runs. Verify
   the new policy on new and previously open connections, without changing boot ID.
5. Add another secret while running. Only that secret should show the affected VM
   as requiring restart; rotating the first secret must not add a restart notice.
6. Restart, then verify the new variable and cleared pending state.
7. Deny credential-store access and retry: preserve edits, show the unlock message,
   and do not repeatedly prompt in the background.
8. Exercise deletion failure/retry and relaunch during pending updates. Remove a VM
   and confirm its old assignments do not trap later secret deletion.

## Verification on 2026-09-09

- Frontend: 515 tests passed across 54 files, including native permission wiring,
  async save failure/draft preservation, safe unlock guidance, pending state and retry.
- Native ordinary suite: 215 passed, five opt-in tests ignored; the existing
  permission-dependent runtime-alias check was excluded.
- Isolated real macOS MicroSandbox test passed: guest placeholders, source-only
  durable config, allowed HTTPS substitution, blocked destination, live rotation,
  domain restriction, deferred additions, restart activation, deletion, and boot IDs.
  An unchanged HTTPS connection handled a second request on the same socket;
  rotation and removal then prevented existing connections from using old values.
  The expanded live test passed in 22.11 seconds. The disposable VM was removed.
- Real production app: added a disposable value through Keychain, relaunched,
  edited domains without reentering the value, and removed it. A second check
  started dev through Silo, verified its placeholder, removed access live, and
  stopped dev again. Metadata had no plaintext value. Secrets was left empty.
- Linux hardware and Secret Service behavior have not been exercised on this host.

Run the opt-in runtime test with the signed bundled `msb` and library paths in
`SILO_TEST_MSB` and `SILO_TEST_LIBKRUNFW`:

```sh
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml \
  live_secret_adapter_uses_refs_and_preserves_boot_for_live_updates \
  -- --ignored --test-threads=1
```

It uses a temporary VM, disposable values, Ubuntu packages, and public HTTPS echo
endpoints. It never reads Silo's user credentials or modifies the user's VM.

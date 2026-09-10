# Remote computers

Silo can manage another computer's VMs while Silo is running on that computer. The Tauri application at `app/SiloUI` owns this implementation. It does not install an independent management daemon.

## User behavior

1. On the owning computer, open Settings → Computers and enable **Allow remote management**. The OS must also accept SSH connections (Remote Login on macOS). Copy the displayed address.
2. On the controlling computer, choose **Connect computer…** and paste the address. Existing OpenSSH configuration, aliases, keys, and agents are reused. SSH URIs support custom ports and IPv6.
3. If SSH has not been authorized, use the explicit Terminal authorization action to verify the fingerprint/unlock an existing key. If key access is absent, **Set up Silo SSH key…** adds this computer's public key to the remote account after SSH's normal trust/password prompts. No private key is copied.
4. Remote VMs appear in the existing flat list. Their small blue VM badge includes a network icon; hover or keyboard focus reveals the computer, address, and availability. Display names can match local VM names.
5. **Run on** selects the owning computer when creating a VM. Existing VM ownership cannot be changed by editing its configuration. Start, stop, restart, edit, and delete operate on that computer. A computer may have no VMs.
6. Terminals and editors launch on the controlling computer and connect to the guest through the owner. Files, logs, repository push, and network connections route to the owning computer.

A controller can connect during onboarding without provisioning a local VM. Local backup/restore, account configuration, secrets, runtime repair, and application updates retain their existing local ownership; the UI labels those settings **This computer**. Remote account configuration and backups are managed on the owning computer. They are not copied or synchronized by connecting it. Per-VM sharing, VM migration, internet discovery, and automatic SSH-server installation are outside this change.

## Close and Quit

Closing the window retains the existing status-bar behavior. **Quit Silo** blocks new work, saves pending preferences, coordinates accepted operations, gracefully stops and verifies all Silo-owned local VMs, closes this controller's tunnels, and exits. VMs on other computers are not stopped.

The existing screen shows **Stopping local VMs…** while shutdown runs. A stop or settings-save failure keeps Silo open with an actionable error and restores manual controls. VMs already stopped are not automatically restarted after a failed Quit. Failed provisioning before metadata publication is handled using its validated recovery journal; unknown managed identities block a successful Quit rather than being silently abandoned.

This describes graceful Quit, not process crashes or forced OS termination. Silo must remain running on the owner for remote management. Disabling remote management ends Silo guest sessions and rejects new management requests; already accepted VM operations retain their owner. It does not revoke an OS account's pre-existing general SSH permissions.

## Implementation boundaries

- `remote.rs` owns saved host identity, framed SSH RPC, the private Unix socket, the fixed bridge CLI, SSH setup, and durable operation acceptance/results.
- `runtime/remote_ops.rs` uses the existing runtime operations and mutation lock. Remote edits/deletes compare the expected VM configuration with the owner's current configuration. No cached controller inventory replaces a host inventory.
- Every remote target combines a stable host UUID and VM UUID. Address changes do not change ownership; an address returning a different host identity is rejected until explicitly reconnected.
- `remote_access.rs`, `editor.rs`, and `terminal.rs` route guest access. Per-controller guest private keys stay local; only public keys are authorized by the owner. Guest streams cannot start stopped VMs.
- `remote_network.rs` owns controller loopback SSH tunnels. A remote loopback address is never shown as a local endpoint without a live tunnel. Removing a connection, disappearing/replaced endpoints, loss of remote access, and successful Quit close owned tunnels.
- `runtime/shutdown.rs` coordinates local shutdown. Settings exit generations prevent an old canceled timeout from completing a newer Quit.
- Local and remote sources remain separate in `production-source.ts`; only presentation combines them. Remote failure does not mark local VMs unavailable. Controller views refresh remote state periodically; this is not disk or configuration synchronization.

Legacy SSH entries remain saved connections. They are not assumed to be Silo hosts or converted into VMs. Operational configuration permits an empty inventory; onboarding retains its explicit initial setup flow.

## Validation

Commands, counts, and final build evidence are recorded after the final verification run below. Automated tests use controlled subprocesses, sockets, and runtime responses; browser inspection uses deterministic fixture data. They do not prove real two-computer hypervisor operation.

The native Swift app under `app/Silo` was not changed or launched. Its build/smoke scripts and fixture identifiers do not validate this Tauri implementation. No user VMs were started, stopped, created, or deleted during implementation verification.

Primary-source basis: [OpenSSH](https://man.openbsd.org/ssh) documents the reused SSH transport, configuration, URIs, and forwarding. The earlier architecture discussion is retained in `SiloUI-REMOTE-HOST-UX-PROPOSAL.md`; its separate-daemon proposal was superseded by the agreed app-lifetime behavior here.

### Final verification results

- `npm --prefix app/SiloUI test`: 77 files, 695 tests passed.
- `cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml`: 327 unit tests and 5 integration tests passed; 10 pre-existing opt-in tests ignored. The initial restricted run could not bind test sockets; the successful run had local socket access.
- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint`: passed without warnings.
- `git diff --check`: passed.
- `npm --prefix app/SiloUI run desktop:build:debug`: passed, producing the ad-hoc signed debug bundle at `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. No notarization or release publication was performed.

Logs are in the ignored directory `app/SiloUI/src-tauri/target/remote-verification/`: `frontend.log`, `rust.log`, `build.log`, and `lint.log`. The earlier frontend failure log was preserved as `frontend-first.log`.

Transport regression tests use real Unix sockets and child processes to check exact EOF drainage, cancellation with full pipes, and process reaping. Other regression tests cover operation non-replay, public-key installation preserving existing authorized keys, last-VM deletion, graceful shutdown including partial provisioning, duplicate VM names, cold/later local failures, scoped network mappings, and idempotent remote activity/result merging.

Browser inspection used the production React components with deterministic fixtures. Observed: two `dev` rows remained distinct; the remote VM badge exposed `Office Mac`, `Connected`, and its address on focus; `Run on` offered this computer and Office Mac; the connection error exposed explicit SSH authorization and key-setup actions. The temporary fixture page, server, and tab were removed.

Remaining acceptance evidence: an installed-app run connecting two real computers, provisioning a disposable VM, opening an editor through SSH, interrupting the connection, reconnecting, and quitting the owning app. Neither a real two-computer VM test nor Linux installed-app validation was performed. The built app was not launched against the user's existing VM inventory.

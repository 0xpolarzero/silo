# Agent tools for the Linux desktop

Adding the optional Linux desktop installs Luda's runtime, MCP registration and
complete skill for the VM's `silo` account. This happens inside the VM's disk
through the desktop recipe, both at creation and when adding the desktop later.
Headless VMs do not install Luda. The account must already use Silo's supported
single-account layout.

## Agent coverage

The installer configures all seven clients supported by the pinned Luda release:
Codex, Claude Code, Cursor, Gemini CLI, OpenCode, VS Code's default local Linux
profile, and GitHub Copilot CLI. Their executables and credentials need not exist
yet. Registration is user-wide, so an agent installed later can discover the
same tools and skill from any project under that account. Existing agent
sessions need to reconnect after setup.

Agents execute the local stdio MCP server through Luda's session launcher, which
finds the `silo` account's active XFCE session. Silo starts and stops the desktop;
Luda does not start it. Manual desktop startup remains supported. No public MCP
listener is opened. Client approvals and skill-loading policies still apply.

Host-side agents and custom profiles are outside this automatic setup. A host
agent running an ordinary SSH command does not inherit guest MCP configuration.
Actual remote backends must load the `silo` account's profile inside the VM.
The optional Luda browser provider and Editor Bridge are not installed.

## Setup and retry

The desktop viewer offers **Set up agent tools** for an existing desktop and
**Repair agent tools** when needed. Setup is explicit; viewing a desktop or
booting a VM never installs packages or rewrites agent configuration. These
actions also work through Silo's remote-computer connection. Update both Silo
applications when using a new action against a remote owner.

Desktop installation and Luda readiness are recorded separately. A failed tool
installation leaves the desktop package installation intact; retry completes
tool setup without reinstalling KasmVNC. Once the matching release is ready,
ordinary recipe retries do not contact the network. Explicit repair reapplies
all-agent registration using the installed runtime when available. Upstream
setup preserves unrelated settings but updates the named `luda` skill and MCP
entry. The client registrations are not one atomic transaction.

The public status reports `ludaState` and `ludaVersion`; the stopped-VM response
does not guess installation readiness. Installer diagnostics remain inside the
guest at `/var/log/silo-luda-install.log`. A root-owned lock prevents overlapping
setup attempts. Guest state is `/var/lib/silo-desktop/luda.json`.

## Reproducible inputs

[`guest/luda-lock.json`](../app/SiloUI/src-tauri/guest/luda-lock.json) pins
Luda v0.3.0, commit `a0e0ef4f9a1d8b29a9b3456ca32167a711897e42`, with source archive
SHA-256 `778195f02a429de72f39e9cc7a4f4aef95edef2fbdcffad2078de9c79c0a51e7`.
The archive is verified before extraction or execution. Luda's upstream installer
owns Python dependencies and pinned client-registration tooling; Silo does not
maintain a second set of agent configuration writers.

The runtime remains under `/opt/luda`; moving its Python virtual environment
would invalidate executable paths. The current Silo installer and lock are
bundled into the application and staged in the guest for installation/repair.
No separate guest-image release is required for this optional recipe change.

Primary sources: [Luda image packaging](https://github.com/0xpolarzero/luda/blob/v0.3.0/docs/ENVIRONMENT-PACKAGING.md),
[installer](https://github.com/0xpolarzero/luda/blob/v0.3.0/scripts/install.sh),
[agent adapters](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/setup_clients.py),
and [session launcher](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/session.py).

## Verification (2026-09-21)

A disposable ARM64 Ubuntu 24.04 v3 VM used the bundled `msb` from
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Account Verification.app`
with an isolated `MSB_HOME` and the current guest recipes. Fresh desktop and Luda
installation completed in 107 seconds. `/opt/luda` occupied 307 MiB.

Live checks passed for all seven user-owned registrations, complete skill
references, idempotent setup, preservation of unrelated Cursor configuration,
a malformed-config failure followed by successful repair, and manual desktop
startup across VM reboot without changing registration or readiness state.
MCP reconnection after reboot succeeded from two separate project directories.
An actual stdio MCP client connected to 36 tools, observed the screen, launched
Mousepad, edited and read back Unicode text (`Café 日本語`), sent Ctrl+S, and
verified the saved file exactly. Test harness retries exposed an externally
modified document dialog and a hidden tab; the final proof used a unique file
and the visible accessibility target.

Automated checks: 470 native tests passed (12 opt-in tests ignored), 33 Python
installer/service tests passed, and 18 targeted desktop frontend tests passed.
Frontend typecheck and lint passed. Commands:

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_luda_setup.py'
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_desktop_service.py'
npm --prefix app/SiloUI test -- src/desktop/linux-desktop-native.test.tsx src/desktop/linux-desktop-viewer.test.tsx
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
# Use the release guide's synthetic GitHub configuration for native unit tests.
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --quiet -- --test-threads=1
```

This proves the guest runtime and MCP GUI path on ARM64. It does not prove each
agent application's discovery/approval UI, x86-64 runtime behavior, a live
two-computer connection, or the newly packaged Silo UI. The app has not been
released or installed, and this verification did not modify the user's VM.

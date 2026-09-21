# Luda desktop integration plan

Research date: 2026-09-21. This records the original plan. Current implementation
and verification are documented in [agent desktop tools](SiloUI-LUDA.md).

## Decision

Install Luda when the user adds the Linux desktop, configuring every supported
agent for the VM's `silo` account. Require the single working-account design.
Older VMs must migrate explicitly or be recreated; desktop installation does
not migrate accounts. The user accepted this scope during implementation.

## Primary-source findings

Reviewed Luda release `v0.3.0`, commit
`a0e0ef4f9a1d8b29a9b3456ca32167a711897e42`:

- [Image packaging](https://github.com/0xpolarzero/luda/blob/v0.3.0/docs/ENVIRONMENT-PACKAGING.md):
  the installer supports account-wide setup before agents exist. A runtime-only
  image build can defer account registration until provisioning. Neither step
  needs a running desktop. The installed virtual environment has absolute paths.
- [Installer](https://github.com/0xpolarzero/luda/blob/v0.3.0/scripts/install.sh):
  use `bash scripts/install.sh --user silo --agent all --yes`. It installs system
  prerequisites and an immutable runtime under `/opt/luda`; setup also installs
  the skill. Python 3.12+ and apt are required. Silo's Ubuntu 24.04 base fits.
- [Client adapters](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/setup_clients.py):
  `all` covers Codex, Claude Code, Cursor, Gemini CLI, OpenCode, VS Code's default
  local Linux profile, and GitHub Copilot CLI. This does not mean arbitrary
  agents or every remote editor profile.
- [Setup implementation](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/setup.py):
  client registration delegates to bundled, pinned upstream installer tooling.
  Use that implementation rather than duplicating client configuration writers
  in Silo. Existing unrelated settings are preserved; same-name Luda entries
  are replaced. Setup across clients is not transactional.
- [Session attachment](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/session.py):
  the launcher discovers the account's XFCE session and supplies its environment
  to the MCP process. It does not start the desktop. Silo owns desktop lifecycle.
- [Client integration guide](https://github.com/0xpolarzero/luda/blob/v0.3.0/docs/AGENT-INTEGRATIONS.md):
  actual client discovery and connection still require verification. An agent
  running on the host does not discover configuration inside a VM simply by
  issuing SSH commands. Client trust and reconnect requirements still apply.

## Implementation sequence

1. Prove compatibility in a disposable Silo VM: install the pinned source as
   `silo`, start the production KasmVNC/Xfce desktop, then run Luda doctor through
   its session launcher. Verify window enumeration, observation and a text edit
   in Mousepad through MCP. Check XTEST, XInput, RandR, D-Bus and accessibility
   against KasmVNC, not just Xvfb. Repeat on ARM64 and AMD64 before claiming both.
2. Add a version and checksum lock for the Luda source archive. Extend the
   optional guest desktop recipe to verify/download that source and run its
   installer after the working account and desktop prerequisites exist. Keep
   base headless VM creation unchanged. This persists in the VM disk, matching
   today's optional desktop installation; it is not a second base OCI image.
3. Record desktop and Luda installation separately. Desktop retries currently
   return early on `installed.json`; make retries finish missing Luda setup
   without reinstalling KasmVNC. Record completion only after all registrations
   succeed. Report partial setup and provide a retry without replacing unrelated
   agent settings. Avoid rerunning setup on every boot.
4. Configure `--agent all`, not executable detection. Standard-profile agents
   installed before or after the desktop then use the same user-wide setup.
   Keep the runtime and full skill references together. No per-agent installer
   hook is required unless an agent installer is shown to overwrite settings.
5. Expose installation failure separately from desktop running/stopped state.
   Say that desktop installation includes agent GUI tools; explain reconnecting
   existing agent sessions. Respect manual desktop startup: registration can
   succeed while the desktop is stopped; tools become usable after it starts.
6. Provide a one-time explicit install/repair path for already-installed desktops
   on supported VMs. Do not silently download or modify agent configuration just
   because a user opens the desktop viewer. Pin upgrades to reviewed Silo releases.
7. Add a compatible-feature changeset and update bundled help and desktop docs.

## Verification

Use fixture tests for missing policy rejection, install interruption/retry,
checksum failure, malformed client config preservation, and late agent setup.
Test source scripts rather than reproducing their implementation in assertions.
Live disposable acceptance must cover an existing populated agent profile,
an initially absent agent, discovery from two project directories, SSH backend
launch, reboot, manual desktop startup, and a visible GUI action. Validate
configuration for all seven adapters; record which actual agent versions were
connected rather than treating generated config as proof of client compatibility.

No Luda installation or live Luda acceptance was performed during this research.
The public release and local source were read; no user VM was modified.

## Remaining choices

- Scope is standard guest-side client profiles. Host-side agents and custom
  profiles need an explicit separate integration; no universal target exists.
- Include core Luda only. Its optional browser provider and Editor Bridge are
  separate work unless requested.
- Measure installation time, disk cost and memory in the disposable prototype.
  Existing desktop estimates do not establish Luda's cost.

Next action: run the pinned Luda proof in a disposable single-account Silo VM.

# Silo E2B replacement plan

**Superseded direction, 2026-09-25:** the user chose to bring upstream MicroSandbox
checkpoints and forks into retained Silo. Follow the
[checkpoint implementation plan](SiloUI-CHECKPOINTS-PLAN.md). This E2B plan is
retained as historical design and qualification context, not the active cutover plan.

**Decision reassessment, 2026-09-24:** the user proposes keeping Silo, adding
efficient checkpoints/live forks, improving the desktop and using full LCU.
The [follow-up research](research/checkpoints-desktop-direction-2026-09-24.md)
finds that released MicroSandbox 0.7.2 already provides an upstream snapshot/fork
implementation to qualify. The [comparative assessment](research/e2b-adoption-assessment-2026-09-24.md)
therefore recommends evaluating that upgrade before an E2B replacement. No
runtime upgrade or desktop selection is qualified or implemented. The E2B plan
below remains conditional on subsequently choosing E2B.

Status: proposed implementation plan, 2026-09-22. This document authorizes no
deployment or deletion of existing user data. The requested direction is a
breaking pre-1.0 replacement: one E2B backend, no MicroSandbox fallback, old
archive reader, configuration migration or compatibility framework.

Updated investigation order, 2026-09-23: follow the
[PoC investigation and completion handoff](SiloUI-E2B-QUALIFICATION-HANDOFF.md)
before cutover work. It corrects unsupported failure attribution, requires exact
binary/source provenance and independent reproductions, and specifies the
remaining qualification gates. Computer use is under rewrite; preserve its
integration seam and defer deeper LCU work.

Current qualification status, reconciled 2026-09-24: **cutover blocked**.
The [current gate matrix](research/e2b-qualification-gates-2026-09-23.md)
separates executed subsets from the remaining adoption work. Later evidence in
the [work log](research/e2b-qualification-worklog-2026-09-23.md) supersedes the
earlier summaries: durable full-desktop host shutdown/restart passed; suite
self-cleanup passed with zero survivors; the last recorded deterministic suite
passed 97 tests. Real GitHub operations and policy-layer revocation passed in
separate harnesses. A packaged Tauri harness delivered modifier-correct input
and denied viewer IPC. Two-computer lifecycle tests passed on native Linux
x86-64. These are bounded passes, not complete workflow qualification.

The pause/checkpoint preservation defect and corrupted successful snapshot
remain unresolved in upstream [#3658](https://github.com/e2b-dev/runtime/issues/3658)
and [#3659](https://github.com/e2b-dev/runtime/issues/3659), both checked open on
2026-09-24. Beyond those fixes and the replacement credential broker, remaining
coverage includes native editor/network interruption and revocation, viewer
interaction/security cases, storage retention, runtime updates, resource
changes, files-only export/import, the remaining platform/remote workflows,
and a fresh final run against one pinned candidate. Detailed evidence remains
in the dated reports; historical test failures are not current defects by default.

Files-only export, restart-to-apply CPU/RAM changes, and viewer-session TTL
survival were accepted on 2026-09-24. Acceptance does not establish runtime
coverage. Concrete lifecycle/checkpoint UI changes still need a before/after
proposal and approval; a host-only start/stop interface is not approved.

## Agreed scope after review

Complete and qualify the standalone PoC before replacing Silo's runtime. Reuse
its proven adapter, host setup, desktop recipe, SSH transport and acceptance
tests in the application. The custom credential broker remains a test fixture;
it is not selected for production.

**User direction, 2026-09-24:** prefer maintained, well-recognized tools and
supported upstream features throughout the refactor. Research existing solutions
before creating infrastructure, retain only necessary Silo policy/integration,
and fix reusable gaps upstream. Successful PoC code does not override this rule.
The [credential-tool comparison](research/e2b-credential-tools-2026-09-24.md)
selects iron.sh's iron-proxy first and Infisical's standalone Agent Vault second,
not an approved production dependency. It also records the E2B deployment gap,
CyberArk's CONNECT limitation, and Envoy's incompatible filter threat model.

Every workspace has a desktop microVM. Bake LCU into the shared desktop template;
run one LCU session inside each microVM beside X11 and D-Bus. E2B owns sandbox
execution and viewer transport, not the computer-use API. LCU replaces both E2B's
computer-use helpers and the PoC's temporary xdotool input implementation.

Keep Silo's existing interface wherever its meaning remains correct. Except for
the explicit decisions recorded below, lifecycle, checkpoint and resource-control
changes remain proposals requiring the user's approval before UI implementation.
This includes any decision to show only host
start/stop controls. E2B still has individual sandbox pause/resume operations;
sharing an outer host does not remove their lifecycle.

A checkpoint must support both **revert this workspace** and **create another
workspace**. Revert preserves Silo's workspace identity while replacing its E2B
sandbox binding. A fork gets a new workspace identity. Current permissions, SSH
identity and credential grants must be applied outside the restored snapshot.

The viewer target is E2B's browser/noVNC approach. Testing it in a native app
window checks compatibility; it does not require preserving Silo's old viewer.

## Decision

Make E2B own sandbox execution, guest commands/files, templates, snapshots and
the underlying network/storage machinery. Keep Silo responsible for the native
experience, execution-host management, workspace ownership, credentials and
repository policy. Replace implementations that have become unnecessary; retain
requirements that still matter.

The [local PoC](research/e2b-local-poc-2026-09-22.md) proves nested ARM64 desktops,
agent input, human takeover, checkpoints, forks, pause/resume and clean host
restart recovery on an M4 Max. It does not yet prove Silo's complete credential,
SSH/editor, portable backup, Linux distribution or remote-owner workflows.

The [historical qualification](research/e2b-lcu-qualification-2026-09-22.md)
records LCU, synthetic credential brokering, Git/LFS and SSH/SFTP successes on
that host across resumed runs. It also records unavailable source runtimes after
checkpoint/pause errors and a later failed latest-state restore. The exact causes
and latest-state recoverability remain unestablished. Our cache cleanup, shutdown
and adapter behavior require investigation alongside E2B. A memory precheck is a
temporary guard, not a durability guarantee. Identify and fix the responsible
layer before deleting Silo's existing runtime.

This should reduce code Silo maintains. It does **not** establish a smaller
installed system: the initial experiment allocated about 28.3 GiB on the Mac,
with a 16 GiB host VM; repeated LCU builds and retained snapshots later exceeded
60 GiB before cache reclamation. Treat infrastructure size and application code size as
separate acceptance measurements.

## 1. Before and after

Today:

```text
Silo React UI
  → Tauri commands
    → Silo runtime/configuration/recovery code
      → patched MicroSandbox CLI + libkrun
        → one VM per workspace
          → OCI root disk + separately managed /workspace ext4 disk
          → account/Git/desktop provisioning scripts
          → KasmVNC + desktop proxy

Remote access adds framed silo-remote RPC, owner-side command dispatch,
guest streams and several feature-specific SSH tunnels.
```

Target:

```text
Silo React UI
  → native Silo owner/client code
    → one small E2B adapter using the official SDK
      → E2B API, envd and client proxy
        → one Firecracker VM per workspace, created from a prepared template
          → one persistent root filesystem, including /workspace
          → prepared Xfce desktop + LCU + OpenSSH
          → noVNC with agent/human input ownership

Mac execution: one private Linux host VM contains E2B and all its microVMs.
Linux execution: E2B runs on a dedicated qualified Linux host with KVM.
Remote control: the same Silo owner operations over authenticated SSH transport.
```

One outer Mac VM still contains multiple inner VMs. E2B does not turn them into
ordinary desktop sessions sharing a kernel. Shared host services remain a common
trust and failure boundary.

| User action | Current flow | Proposed flow |
| --- | --- | --- |
| First local setup | Stage bundled MicroSandbox and import guest archive | Prepare one owned Linux execution host, start the pinned E2B stack, prepare templates |
| Create workspace | Create VM and disks, establish working account, configure optional tools | Create from a ready template, apply current policy and identity, publish it as ready |
| Start | Boot a stopped VM and reconcile guest configuration | Resume paused memory, or explicitly cold-start saved disk state |
| Desktop | Install/configure optional desktop and open KasmVNC | Open the already prepared Xfce/noVNC session |
| Human takeover | Existing viewer behavior without this PoC's explicit shared-input contract | Acquire human input ownership; reject new agent input; invalidate old viewer sessions |
| Save state | Stop VM, export disk state and volumes, try to restart | Checkpoint memory and disk; reconnect live streams afterward |
| Restore checkpoint | Import archive into a new stopped VM | Revert the current workspace, or create another workspace from the same checkpoint |
| Export for safekeeping | Full MicroSandbox VM archive | Explicit project-file export; full-machine export is not claimed without a supported implementation |
| Terminal/files | CLI execution, directory scripts and runtime SSH | SDK command/file/PTY APIs; standard SSH remains for native editors |
| Connect another computer | Silo-specific framed SSH RPC and per-feature routes | One owner API over SSH, with the same resource identities and operations |
| Quit local owner | Stop local MicroSandbox VMs | Pause and verify local E2B sandboxes, then stop the owned outer VM |
| Quit a controller | Close its remote tunnels | Disconnect its sessions; remote work keeps running under the owner's lifecycle policy |

## 2. Product decisions that remove complexity

These are proposed intentional behavior changes, not promises of feature parity.

1. **One runtime.** E2B is the only shipped sandbox backend after cutover.
   No provider registry, generic runtime plugin system or legacy feature flag.
2. **One workspace filesystem.** Keep `/workspace` as a normal directory in
   the sandbox root. Remove the separate ext4 volume, independent runtime and
   workspace capacity sliders, disk formatting, trim scheduler and volume archive
   code. Persistent E2B volumes are deferred until a demonstrated workflow needs
   data independent of sandbox checkpoints.
3. **One desktop template.** Every microVM includes Xfce, LCU, OpenSSH and Git
   tooling. Install LCU once during template build; its process runs separately
   inside each guest. No CLI-only variant or optional desktop installer.
4. **Explicit lifecycle language.** Use Create, Pause, Resume, Restart, Checkpoint,
   Revert, Create from checkpoint, and Delete, subject to UI approval. Restart means a cold restart preserving files,
   never killing the sandbox and accidentally losing its disk. If that path is
   not qualified on the pinned runtime, omit Restart until it is.
5. **Resource profiles that the backend actually supports.** Remove CPU/memory
   ceilings and arbitrary live-resize controls. Start with a small set of tested
   template/resource profiles. Configuration changes that need a replacement
   workspace say so; they do not pretend to edit a saved VM's hardware in place.
   **Decision (user, 2026-09-24): restart-to-apply is accepted** — changing a
   desktop's CPU/RAM applies via a restart from its own saved state (files and
   checkpoints survive; running programs do not). The UI states this plainly
   and never promises live hardware edits.
6. **Checkpoints and exports have separate meanings.** Checkpoints preserve the
   sandbox on its owner. Project export is a portable file artifact. Do not label
   an owner-local snapshot as a backup against losing the owner disk.
7. **No legacy SSH-only machines in the workspace model.** A saved SSH connection
   identifies an execution host; a workspace is an E2B sandbox on that host.
   SSH remains a transport and an editor capability, not a second machine kind.
8. **LCU is the computer-use implementation.** Pin its release and checksum in
   the desktop recipe. Expose its MCP interface, instruction fidelity and semantic
   desktop API without reimplementing mouse/keyboard helpers. Keep E2B commands,
   files and transport separate. Delete old Luda/Cual bootstrap and E2B computer-use
   wrappers when the LCU acceptance suite passes.
9. **Qualified platforms, not fallbacks.** Local Mac execution requires M3+ and
   macOS 15+. Older hardware can be a remote controller if it satisfies the app's
   client requirements; it does not get a second VM engine. Initially qualify
   Ubuntu 26.04 as the execution host on ARM64 and x86-64. A VM host must expose
   nested KVM. Do not silently upgrade an existing Linux kernel or distribution.

The PoC's 16 GiB host allocation is not an acceptable automatic default on every
M3 Mac. Qualify smaller profiles and set a truthful minimum physical-memory
requirement. Until then, only the measured 64 GiB M4 machine is demonstrated.

## 3. Ownership and implementation boundaries

Use the existing React/Tauri app. Extract a small Rust owner module from the
current native backend. It owns Silo metadata, operations, host setup, native
credentials and access decisions; it does not reimplement E2B's VM scheduler,
guest agent, image cache or storage engine.

Use the **official Python SDK through one private adapter in the Linux execution
environment**, initially derived from the tested PoC. This reuses working code
and avoids implementing E2B's streaming/guest protocols in Rust or adding a Node
runtime just for an SDK. Python already exists in the qualified Linux host.
Keep SDK types and credentials behind that module. Do not move the entire
product into the PoC's Python server.

The extra adapter is a deliberate dependency. Validate its deployment and
streaming behavior in the first native integration slice. Retire the experimental
server after its useful code and tests have one production home; do not maintain
both implementations.

```text
app/SiloUI/src-tauri/src/
  hosts/          # owned Lima host, dedicated Linux host, SSH connections
  workspaces/     # Silo IDs, desired settings, bounded operations and recovery
  e2b/            # private adapter client; no second VM implementation
  access/         # viewer, PTY, port and editor session ownership
  credentials/    # existing GitHub/secure-store policy, new runtime delivery seam
  exports/        # project files + manifest, not old VM archives
  native/         # existing OS integrations, menus, launchers, updates

runtime/e2b/
  adapter/        # official SDK calls and streams; minimal Silo-specific state
  host/           # pinned Compose inputs, preflight, service/start/stop scripts
  templates/      # pinned desktop + LCU recipe and validation
```

This tree describes responsibilities, not a requirement to rename every good
existing file. Preserve an existing deep module when its responsibility survives.

### Sources of truth

| State | Authority |
| --- | --- |
| Runtime existence, running/paused state, runtime metrics | E2B on the execution host |
| Workspace name, owner, selected template, user policy and checkpoint labels | Silo owner |
| Accepted Silo operation and recovery intent | One owner operation journal |
| Account credentials and policy revisions | The owning computer's credential broker |
| UI selection, open panels and preferences | Silo client |

Use one small transactional store for owner workspace metadata and operation
intent, rather than reproducing the existing collection of recovery JSON files.
Do not copy E2B's runtime database into it. Preserve distinct host and workspace
UUIDs and the current E2B sandbox ID. A display name is never an identity.

Expose the same typed owner operations to the local Tauri bindings and a remote
HTTP endpoint tunneled through SSH. These are two actual entry points into the
same implementation, not two lifecycle adapters. Keep ordinary remote commands
out of a new custom framing protocol. Streams use standard HTTP/WebSocket
mechanisms with bounded buffers and explicit close/cancellation.

The current native owner can remain attached to the Silo process for the first
integrated build. For unattended Linux servers, provide a headless entry point
using the same owner module, not a second remote backend. Keep credential-store
unlock and lifetime explicit; a server must not depend on an invisible GUI
prompt. Do not expand Mac background-agent behavior before its ownership and
shutdown contract has a real use case and test.

### Concurrency and recovery

- Serialize mutations per workspace, with a separate host setup/shutdown lock.
  Independent workspaces must not block behind a global CLI mutation lock.
- Tag creates with owner/workspace/operation IDs. If a request times out after
  acceptance, reconcile inventory before retrying. Do not assume an upstream
  create endpoint provides idempotency merely because Silo sends a key.
- Distinguish desired state, observed state, operation failure and disconnected
  observation. A disconnected host is not a failed or deleted sandbox.
- Recover only recorded, owned operations. Unknown runtime IDs remain unknown;
  never kill resources merely because they are absent from the current UI list.
- A successful operation means its postcondition was verified. Host shutdown
  must prove pause completion before stopping the orchestrator. Failed pause or
  insufficient snapshot space leaves the host running with an actionable error.

## 4. Exact replacement and deletion map

Paths below are relative to `app/SiloUI`, unless otherwise indicated. Deletion
targets are scoped by responsibility: some files also contain useful policy.

| Current code | Replacement | Delete after its replacement passes |
| --- | --- | --- |
| `src-tauri/src/runtime.rs`, `runtime/configuration_recovery.rs`, `runtime/lifecycle_recovery.rs`, `runtime/crash_acknowledgement.rs` | Owner workspace operations + E2B adapter | CLI construction, output parsing, runtime-path aliases, MicroSandbox status/config reconciliation; consolidate surviving recovery requirements |
| `runtime/shutdown.rs`, `runtime/update_recovery.rs` | Verified E2B pause/host-stop and version-aware update workflow | MicroSandbox stop/start assumptions and recovery formats; preserve accepted-operation and failure handling |
| `src-tauri/src/guest_image.rs`, `microsandbox-image` Cargo dependency | E2B template preparation | Rust ext4 construction, OCI import/stitch logic and old image cache checks |
| `src-tauri/src/runtime/storage.rs` | Host capacity, snapshot retention and measured allocation | Separate volume maintenance, trim history, storage-protocol negotiation and Imago-specific repairs |
| `src-tauri/src/backup.rs`, `backup_controller.rs`, `backup_controller/recovery.rs` | E2B checkpoints with revert and fork; separately qualified export | Old archive format, sparse codecs, stopped-VM snapshots, mount validators and multi-VM archive restore UI |
| `src-tauri/src/desktop.rs`, `desktop_proxy.rs`, parts of `desktop_viewer.rs` | Prepared Xfce template + authenticated noVNC gateway + input ownership | KasmVNC credentials, install/repair progress, proxy protocol specifics; keep useful native window lifecycle |
| `src-tauri/guest/setup-desktop.sh`, `desktop-service.py` | Template build/start recipe | Download/install/retry-at-runtime desktop state machine |
| `src-tauri/src/files.rs`, `guest/list-directory.py` | SDK filesystem operations | NUL-record shell parser and command transport; retain bounded listing/cache behavior only where needed |
| `src-tauri/src/terminal.rs` | SDK PTY with a small `silo shell` native launcher | `msb exec` construction; keep terminal application integration |
| `src-tauri/src/editor.rs`, `ssh_access.rs`, `remote_ssh_access.rs` | One qualified SSH/SFTP guest endpoint and host routing | MicroSandbox stdio SSH server coupling and duplicate local/remote access paths |
| `src-tauri/src/network.rs`, `remote_network.rs` | E2B HTTP/WS traffic routing and one qualified raw-TCP relay | Runtime control-socket protocol and duplicated publication/reconciliation; keep explicit exposure and connection removal |
| `src-tauri/src/remote.rs`, `remote_access.rs`, `runtime/remote_ops.rs`, `silo-remote` bridge | Shared owner API over SSH | Framed protocol, feature-specific remote commands, duplicate operations; retain host trust and identity checks |
| `src-tauri/src/secrets_runtime.rs`, runtime-specific portions of `runtime.rs` GitHub integration | Credential broker connected to the new execution boundary | MicroSandbox environment/profile encoding after equivalent enforcement passes |
| `src-tauri/src/working_account.rs`, `guest/migrate-working-account.py`, `scripts/migrate-working-account.py` | One working user baked into templates | Account migration and guest repair paths; keep identity/permission assertions |
| `guest/setup-luda.py`, `guest/luda-lock.json` and runtime coupling | Pinned LCU baked into every desktop template | Mandatory Luda bootstrap/state handling in core runtime |
| `scripts/prepare-microsandbox-runtime.mjs`, `microsandbox-runtime.*`, `patches/microsandbox-create-stopped-0.6.17.patch`, Imago patch tests | Pinned E2B/host/template preparation | Patched MicroSandbox build, agent/libkrun inputs and runtime-specific cache jobs |
| `guest-image/`, old `scripts/guest-image.*` / `build-guest-image.*`, old guest archive resources | One template release pipeline | Docker-save archive staging/import path after new templates pass |
| `src/desktop/production-source.ts`, `src/contracts/silo.ts`, related models/fixtures | Fresh strict host/workspace/checkpoint/session contracts | `kind: ssh`, old resource ceilings, obsolete backup/status shapes, fallback defaults for old schemas |

The three files `runtime.rs`, `backup.rs` and `backup_controller.rs` alone
contain 10,702 lines including tests. They are inspection priorities, not a
promise that every line can disappear. Do not set an invented deletion
percentage; track net maintained code, dependencies, protocols and deployment
components per milestone.

### Keep because E2B does not replace them

- React UI, navigation, command palette and accessible components.
- OS application discovery, terminal/editor/browser launchers, tray, menus,
  notifications, settings, updater and release signing.
- `github.rs`, `github_tokens.rs`, `github_http.rs`, personal-token handling,
  repository policy and secure-store logic, with runtime-specific calls removed.
- `secrets.rs` credential lifecycle and explicit permission boundaries.
- Host Push's isolated Git/LFS handling and permission boundary. Replace only
  `host_push_transport.rs` and related guest transport as required. Bundled Git,
  Git LFS and the transfer helper are not obsolete just because `msb` disappears.
- Host identity, log export/retention and operation error semantics where useful.
- `src-tauri/vendor/tauri-plugin-updater`: this is a Tauri update patch, not the
  MicroSandbox runtime patch. Review it against its own upstream resolution.

Update `AGENTS.md`'s current instruction to preserve the bundled MicroSandbox
runtime when the replacement is implemented. The requested plan supersedes that
old implementation direction; no permission detour is needed to plan its removal.

## 5. Gaps that must be resolved before cutover

### A. Credentials and GitHub authorization: first technical gate

Do not replace Silo's external credential injection with ordinary guest
environment variables. Full memory snapshots would preserve those values too.
The existing design has repository-scoped read/write grants, live revocation,
selective TLS handling and host-only Push. Those are product guarantees.

Source inspection finds a concrete self-hosting gap:

- The pinned runtime's secret-management API requires a separate configured
  backend and feature flag; without them it returns 403. Its architecture names
  `orchestrator-ee` for resolving secret markers at egress.
- The open-source TCP firewall implementation returns false from
  `SupportsBYOP`; the orchestrator rejects unsupported user-provided egress proxy
  configurations. A field in the SDK is not proof that Embed implements it.
- The current Compose deployment does not configure the customer secret-store
  backend. The PoC has not exercised equivalent secret injection.

Implementation direction, revised 2026-09-24: preserve Silo's native credential
authority and qualify an existing credential broker outside all sandbox VMs.
Start with iron-proxy, then Infisical Agent Vault; a supported E2B injection backend
remains an alternative if its local deployment and redistribution are established.
See the [tool comparison](research/e2b-credential-tools-2026-09-24.md) for exact
remaining requirements. Do not promote `credential-broker.py`, implement a new
HTTP/TLS proxy, or copy its fixture GitHub path recognizer into production.
Keep provider-issued GitHub scope enforcement and Silo's current grant selection.
Broker storage, revocation and runtime identity must meet the existing contract;
an extra credential database or cached authority is not an implicit exception.
Do not carry the old hypervisor along to keep its proxy, and do not silently
substitute a cloud-only service or weaker guest-token scheme.

The controlled-origin disposable-credential test now passes, including actual
Git push/clone and LFS blob upload/download. It does not qualify production
GitHub App grants, gh/GraphQL, redirects, streaming bodies or hostile encoded
secret reflection. Retain these gates:

The gate is an end-to-end disposable-credential test: guest uses a placeholder,
authorized server receives the value, wrong destination/identity is denied,
rotation closes old authority, and restoring an old snapshot cannot revive a
revoked grant. Preserve read-A/write-B/deny-C GitHub behavior, Git/LFS/gh and
GraphQL scope handling. No raw parent token in guest memory, disk, logs or
template configuration.

Policy remains outside snapshots. Before allowing restored/forked workloads to
reach services, apply the **current** owner policy and bind the new runtime ID.
Quarantine or deny access while reconciliation is incomplete. A guest-supplied
header or copied file cannot establish its sandbox identity. If this cannot be
implemented cleanly on Embed, the cutover is blocked until the security contract
or deployment choice is explicitly changed. Pre-1.0 compatibility freedom does
not solve a missing enforcement mechanism.

### B. Native SSH, editors and generic TCP

The expanded PoC proves SSH binary transport, SFTP, EOF, stderr, exit status,
revocation and unique host identities. VS Code Remote SSH connected and started
its ARM64 server through the relay. Native editor GUI save/reconnect and generic
TCP use beyond SSH remain unqualified. E2B's header-routed
client-proxy URL is not itself an OpenSSH endpoint.

Qualify one standard OpenSSH server in the template, key-only login, distinct
identity per fork and no public listener by default. Route it through one
owned, bounded relay using a supported E2B path, or a narrowly scoped host-side
bridge. Reuse that mechanism for raw TCP where appropriate. Never expose envd
or E2B's team key to an editor or terminal subprocess.

Tests: actual Zed/VS Code connection, SFTP upload/download, binary streams,
half-close, stopped-workspace refusal, forked host-key identity, access removal
closing active connections, and remote-host disconnect/reconnect. No standalone
SSH-only workspace compatibility mode.

### C. State durability, export and runtime upgrades

**Blocking executed failures:** the pinned default checkpoint path stops its old
sandbox even if fresh resume fails; API error handling then removes the runtime.
This is now demonstrated at two boundaries on a source-built candidate — an
inserted post-capture return and, per the 2026-09-23 late session, an exact-ID
error at the real `ResumeSandbox` call site itself — each with a passing unarmed
control (runs `280a431d…`/`a0fdce09…` and
`16f2d77d…`/`29f28a3d…`). Separately, a pause whose rootfs-diff `File.Sync`
returns a kernel `EIO` loses the guest identically: reproduced **on the pinned,
unpatched release binary** by ptrace-injecting `EIO` into the actual `fsync` of
the actual diff file (runs `bf19ecc9…`, `4dcd6f60…`, 2/2, with the byte-for-byte
historical error chain). A later release-binary run reproduced the checkpoint
failure with real hugepage exhaustion and kernel ENOMEM. The exact physical
writeback cause and incident-time source mapping remain unestablished; see
[causal bounds](research/e2b-causal-bounds-2026-09-23-late.md). Require a
regression that preserves either the live source or a discoverable, complete,
resumable paused state for both failures. Silo must never report success for a
missing runtime. Include Mac physical capacity as well as Linux guest capacity.


The snapshot side is now equally blocking: the historical "successful" pause
during that same storage-exhaustion window stored internally inconsistent
state, and its restore panics Firecracker deterministically (reproduced 3/3
from hash-verified artifacts on a healthy host; the previous generation
restores cleanly — see [D3 root
cause](research/e2b-d3-root-cause-2026-09-23.md) and
[e2b-dev/runtime#3659](https://github.com/e2b-dev/runtime/issues/3659)). A
pause/checkpoint response therefore proves neither preservation nor
restorability until E2B ships capture-side verification or Silo adds its own
post-capture integrity check.

Primary behavior: checkpoint memory and disk; revert the existing logical
workspace; create a new workspace from any retained checkpoint. Verify unchanged
process memory, independent filesystem writes, source survival after a failed
restore, host restart recovery and checkpoint deletion/reference accounting.
Journal a revert before replacing its runtime binding. A failed readiness check
must leave the previous VM recoverable, and a controller crash must not publish
an unprepared replacement. Retire the old VM only after the new binding commits.

**Decision (user, 2026-09-24): files-only export is accepted.** Checkpoints
remain local runtime artifacts; the user-facing export is a project archive —
`/workspace` files plus a small documented manifest, preserving filenames,
modes, symlinks and uncommitted work, with checksum-verified import through
standard archive tooling (no new sparse-disk format). Import creates a new
workspace from a current template; it deliberately does not restore running
programs, installed packages or process memory. The old full-VM backup
feature is removed at cutover along with its archive reader; project export
must not be relabeled as its equivalent. Full-machine portability remains a
possible separate future feature requiring a supported artifact contract
and a fresh-host restore test.

Runtime updates need their own gate: E2B version changes, Firecracker kernels,
CPU features and memory snapshots must be tested together. Do not assume a
snapshot is portable between M3/M4, x86-64/ARM64, hosts or runtime versions.
When memory restore is incompatible, use a **qualified current-format disk-only
restart/export path**, not the old MicroSandbox engine. If none is safe, block
the update rather than discard state. Keep schema/runtime pins with artifacts.

**Decision/clarification (user, 2026-09-24): viewer-session TTL survival after
an owner-app restart is acceptable** — the question is largely moot because
quitting Silo stops its local execution host (parity with current Silo
behavior, now safe through the qualified durability barrier), and for remote
hosts the viewing relay dies with the owner app anyway. Sessions surviving a
control-service restart while the app keeps running behave as reconnects,
which is the desired semantics; ownership changes already reject held
tickets immediately.

### D. Packaged WebKit and reliable input

A disposable native WKWebView harness rendered noVNC and observed takeover.
The later [input investigation](research/e2b-viewer-input-root-cause-2026-09-24.md)
isolated the synthetic-event failure and proved modifier-correct input through
both WKWebView and a packaged, production-version-matched Tauri harness. The
Tauri harness also rejected a viewer IPC probe. A human keypress is now optional
confirmation; no user input is needed to continue qualification. Remaining
coverage includes keyboard layouts, Cmd/Ctrl mapping, Unicode, clipboard,
scroll/drag, resize/DPI, focus and session/lifecycle reconnect behavior across
the promised platforms. The previously rejected observer-input experiment stays
unmeasured; server role routing alone does not establish hostile-client denial.
Keep viewer windows outside privileged application IPC capabilities. Give each
viewer a short-lived workspace-scoped session, not the E2B team API key.

Human takeover must serialize with dispatched agent actions and invalidate both
old observer and interactive sessions. Read-only observations can remain available
to the agent. Background guest processes are not canceled by input takeover;
the UI must not promise an agent-wide execution stop.

## 6. Delivery sequence and exit criteria

Implement on one replacement branch with cohesive, independently reviewable
changes. Intermediate code can coexist while being developed; the shipped result
contains one backend. Do not create a user-facing engine switch or long-lived
dual-write state.

### Phase 1: finish the reusable PoC and record all adoption gates

Historical progress lives in the
[qualification report](research/e2b-lcu-qualification-2026-09-22.md); the
[corrected execution brief](SiloUI-E2B-QUALIFICATION-HANDOFF.md) defines the
current gates. Reproduce and attribute checkpoint/pause/restore failures, then
fix the responsible layer. Parallelize independent credential and access work;
serialize mutations on a shared test host. Avoid adding product UI while these
runtime decisions are unresolved.


- Preserve the per-guest computer-use integration seam and basic desktop
  readiness. Defer deeper LCU qualification while its implementation is rewritten.
- Test checkpoint fork and revert, operation failure/recovery and current policy.
- Implement and attack-test placeholder credential substitution outside guests,
  using disposable credentials and a controlled Git/GitHub-shaped upstream.
- Prove SDK PTY, raw SSH/SFTP/editor, HTTP/WS/TCP and their failure behavior.
- Test E2B's viewer in an isolated native webview harness. Do not alter Silo UI.
- Measure host/guest resource limits and qualify feasible host RAM profiles.
- Record tests requiring another computer, M3 hardware, Linux x86-64, production
  GitHub grants or installed editor apps as unrun until actually executed.
- Produce concrete UI proposals only after these results; obtain approval for
  lifecycle, checkpoint, resource and other visible behavior changes.

**Exit:** every required behavior has executed evidence, or the user has approved
an explicit product cut after reviewing its consequences. No Silo cutover while
required seams remain unproven, and no UI redesign without approval.

### Phase 2: own and package the execution host

- Pin Lima, Ubuntu, E2B platform/Compose, SDK and template inputs with checksums.
- Give the runtime one private persistent application data root and owner identity.
- On Mac, manage one VZ Linux VM with nested virtualization and no shared home,
  imported SSH keys or forwarded agent. On Linux, preflight a dedicated host.
- Isolate the privileged E2B deployment. Never use the user's default Docker
  context or alter unrelated Docker services as installation/cleanup.
- Bind/firewall management endpoints so neither guests nor the LAN can reach
  unauthenticated orchestrator control. The stock Embed ports need explicit
  treatment on a directly connected Linux host, not just Mac port-forward rules.
- Implement prepare/start/reconcile/health/pause-all/stop/diagnostics through
  bounded subprocesses and readiness checks. No generic shell-command endpoint.
- Move the PoC's build-tier adjustment into versioned, idempotent host setup;
  stop using routine Redis `FLUSHDB` as an installation mechanism.
- Separate application, execution-runtime and template updates. Installing a
  Silo UI update must not silently replace a running E2B control plane.

**Exit:** clean installation, interrupted/resumed setup, corrupt download,
unsupported machine, full disk, restart and safe uninstall all behave truthfully.
An existing unrelated container/VM remains untouched.

### Phase 3: replace workspace contracts and lifecycle

- Introduce Host, Workspace, Template, Checkpoint and Session identities.
- Replace the `vm | ssh` union and MicroSandbox status/configuration contracts.
- Implement create, pause, resume, delete, checkpoint, restore-as-new and the
  qualified cold restart operation. Set timeout policy to pause explicitly;
  discovery and viewer polling must not auto-resume paused workspaces.
- Create one operation journal with postcondition reconciliation, request IDs,
  bounded retries and exact resource ownership checks.
- Replace global mutation serialization with per-workspace serialization.
- Use a current inventory fetch plus bounded refresh/reconnection. Do not depend
  on E2B cloud webhooks unless the self-hosted backend is actually deployed.

**Exit:** restart the owner during each lifecycle operation; recover without
duplicate creation, wrong-resource deletion or a false success state. Paused
workspaces remain paused while users browse Files/Logs/Network.

### Phase 4: replace images and guest provisioning

- Publish one immutable architecture-specific desktop recipe with LCU in every workspace.
- Include the working user, `/workspace`, Git/LFS/gh and qualified access tools.
  Keep tokens, SSH private identities and user data out of templates.
- Prepare E2B templates on each execution host from the published images. Do not
  assume a prebuilt memory snapshot is portable across all customer hardware.
- Launch the desktop before template snapshot, preserving the tested X11/D-Bus
  session contract. Keep GUI agent operations independent of template building.
- Provision Git identity and current authorization after creation, before Ready.
- Cache completed templates so routine workspace creation works offline after
  installation. Document the initial online runtime/template download requirement.

**Exit:** create both variants from a clean host, with no package-manager calls
per workspace; validate permissions, Unicode, tools and correct architecture.

### Phase 5: connect the actual Silo workflows

Implement only the UI changes explicitly approved after Phase 1. Preserve the
existing navigation, workspace presentation and interactions wherever possible.

- Replace runtime reads and mutations in `production-source.ts` with the new
  strict contracts. Remove old field defaults instead of hiding missing data.
- Keep workspace lists, Files, repository views, activity and command palette.
  Rename lifecycle actions to their actual behavior and remove obsolete settings.
- Replace directory scripts with SDK calls, retaining truthful errors, bounded
  page sizes and stale-response protection. Add upload/download only as required
  for the new export and working-file flows.
- Wire noVNC, human/agent input ownership, screenshots and current viewer sessions.
- Replace terminal transport with SDK PTY; retain OS terminal launchers through
  a small token-free native command. Wire the qualified editor/SSH path.
- Replace runtime port publication with the qualified HTTP/WS/TCP routes; keep
  local-only defaults and explicit revocation. A discovered service is not
  automatically an exposed service.
- Connect existing GitHub, secrets and Host Push policies through their new seams.

**Exit:** create a workspace in Silo, clone an authorized repo, run an agent task,
edit in a native editor and desktop, open its development server, hand control
to a human, verify the saved result and checkpoint it.

### Phase 6: unify remote hosts

- Put the same owner operations behind SSH-authenticated HTTP/stream transport.
- Preserve host-key checking, owner UUID verification, controller identity and
  per-workspace authorization. Remote loopback URLs are not local URLs without
  a working owned tunnel.
- Remove framed `silo-remote` RPC and separate remote lifecycle implementations.
- Support the headless Linux owner with the same code; do not require a desktop
  environment on a server just to manage desktop sandboxes.
- Keep credential ownership on the execution owner. Connecting a computer does
  not copy or synchronize accounts/secrets from the controller.
- Closing a client closes its viewer/tunnels, not remote jobs. Explicit owner
  shutdown pauses its workspaces; a controller disconnect does not claim that
  shutdown occurred.

**Exit:** two real computers, including a Linux owner: create, PTY, editor, file
transfer, viewer, checkpoint, disconnect, reconnect and owner restart. Duplicate
workspace names on separate hosts remain distinct throughout.

### Phase 7: storage, retention and operational reliability

- Ship checkpoint listing, labeling, deletion and restore-as-new. Validate E2B's
  template/snapshot reference accounting before deleting retained artifacts.
- Ship project export/import with cancellation and fresh-host file verification.
- Show guest usage, configured capacity and host allocated bytes separately;
  shared templates cannot be summed as independent per-workspace physical disks.
- Bound logs, temporary exports, build caches and retained checkpoints. Manual
  checkpoints are never silently deleted to make a new checkpoint succeed.
- Verify actual host allocation recovers after cleanup. Removing guest files
  alone does not prove APFS/sparse-host allocation shrinks.
- Pause all owned local workspaces before host stop/update; verify runtime state
  independently and reconcile host networking on the next start.
- Exercise low disk, failed checkpoint upload, process crashes, abrupt VM loss,
  stale runtime records, broken tunnels and revoked viewer/credential sessions.

**Exit:** clean shutdown preserves files and memory; forced failures produce
bounded, honest recovery states; the user can distinguish the last saved
checkpoint from lost unsaved state. Repeat tests, do not generalize one boot.

### Phase 8: delete the old stack and finish packaging

- Delete the files/responsibilities in the replacement map, old commands,
  contracts, fixtures, migration scripts, recovery formats and their obsolete tests.
- Remove `msb`, libkrunfw, `microsandbox-image`, old image archives and patches
  from Cargo, Tauri resources/external binaries, preparation and release manifests.
- Replace runtime-specific CI/cache/signing checks with Lima/E2B artifact and
  capability checks. Preserve general Git, updater, signing and Linux packaging.
- Regenerate lockfiles and third-party notices; inspect the final bundle contents.
- Remove the separate PoC UI/server after moving its useful acceptance tests into
  the production verification harness. Keep its dated findings as historical evidence.
- Replace stale user docs, help, screenshots and AGENTS instructions. Remove old
  active implementation plans; keep dated research only if clearly labeled historical.
- Add a breaking-behavior changeset according to repository policy; do not bump
  versions or publish as part of this plan.

**Exit:** no MicroSandbox/Imago/KasmVNC runtime code, binaries, dependencies,
fallback paths or migration adapters in the shipped app. Historical documentation
references are an explicit exception, not a reason to retain implementation.

## 7. Required verification matrix

| Boundary | Required evidence |
| --- | --- |
| Actual app | Packaged macOS WebKit and Linux WebKitGTK, not just browser fixtures |
| Host support | M3 hardware, measured M4 baseline, qualified Linux ARM64/x86-64, unsupported/KVM-missing preflight |
| Resources | Cold installation and startup, one/three/budget-limit desktops, CLI versus Desktop, long-lived host usage |
| Isolation | File/process/kernel checks plus denied sibling, host-management and metadata destinations; IPv4/IPv6/DNS cases |
| Commands/PTY/files | Binary bytes, Unicode/newlines, large bounded transfers, resize, signal, EOF, nonzero exit, interrupted streams |
| Human control | Real input, two viewers, concurrent agent action, focus/clipboard/layout changes, stale session revocation |
| Credentials | Read/write repo scopes, blocked destinations, live rotation/removal, replay from a restored snapshot, owner-store lock |
| Recovery | Pause/resume, fork, owner restart, host restart, low disk, lost create response, incompatible runtime snapshot |
| Networking/SSH | HTTP/HTTPS/WS/raw TCP, SFTP, real native editor, half-close, removal ending active sessions |
| Export | Fresh host with no original cache; exact project bytes/modes/links; cancellation and corrupt/path-traversal rejection |
| Remote | Two-computer acceptance, same names, wrong host identity, disconnection, controller quit and owner shutdown |
| Distribution | Clean install, upgrade policy, signatures/entitlements, checksums, licenses, no legacy runtime in final artifacts |

Run focused behavior tests while implementing each vertical slice, then the
repository's typecheck/lint/frontend/native/release checks appropriate to the
changed areas. Keep hardware and credential tests opt-in with synthetic data.
Do not replace useful regression properties with mocks of SDK method calls.

Record exact runtime/template/app versions, hardware, guest architecture and
whether evidence is a unit test, fixture, live API or packaged UI run. Measure
p50/p95 across repeated samples for the new latency budget; the PoC's individual
timings are a baseline, not an SLA. Include app download size, total host storage,
RAM reservation, idle CPU, create/resume, screenshot/input and shutdown times.

## 8. Deletion discipline and cutover

- Every replacement change names what it removes and proves the retained user
  behavior. Copying the existing runtime behind a new `E2BBackend` name fails.
- No architecture-neutral factory until two real implementations require it.
  Mac host provisioning versus Linux host preparation are real differences;
  MicroSandbox versus E2B is not a supported choice after this replacement.
- No best-effort compatibility defaults, old archive readers or silently
  rewritten saved configurations. Use a fresh E2B data root.
- Old user VM directories stay inert and untouched. Removing code is not consent
  to erase project files. Cleanup is an explicit user action outside the new
  runtime; no importer or background migration is added.
- Removing an old recovery mechanism requires retaining its failure guarantee
  through the new operation journal. Recovery, revocation and bounds are not
  legacy clutter merely because their first implementation served MicroSandbox.
- Do not fork E2B's internal control plane to shave dependency count. Begin with
  the pinned working deployment. Remove unused dashboard services only after
  dependency/readiness tests establish the smaller deployment; keep required
  stores and logging until upstream provides a qualified lean configuration.

Cut over only when Phase 1 gaps and the required product flows have evidence.
The shipped app has no backend selector or migration promise. The next concrete
implementation is the **credential + SSH + packaged-viewer qualification slice**;
that resolves the highest-risk gaps before most of the rewrite is spent.

## Evidence and sources

Repository basis: current `src-tauri/src/runtime.rs`, `remote.rs`, `network.rs`,
`desktop_viewer.rs`, `Cargo.toml`, `tauri.conf.json`, `src/desktop/production-source.ts`
and `src/contracts/silo.ts`; the [PoC results](research/e2b-local-poc-2026-09-22.md);
[remote ownership](SiloUI-REMOTE-COMPUTERS.md), [secrets](SiloUI-SECRETS.md),
[GitHub](SiloUI-GITHUB-IMPLEMENTATION.md), [native editor](SiloUI-EDITOR-HANDOFF.md),
[network](SiloUI-NETWORK-PLAN.md), [backup](SiloUI-RUNTIME-BACKUP-FINDINGS.md),
[guest distribution](SiloUI-GUEST-IMAGES.md) and
[storage reclamation](SiloUI-STORAGE-RECLAMATION.md).

Upstream basis, inspected September 22:

- [Pinned E2B Embed guide](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/embed/README.md): self-hosting, header routing, exposed ports and evaluation scope.
- [Pinned Compose requirements](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/embed/compose/README.md): host/kernel/architecture and resource requirements.
- [Pinned architecture](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/docs/ARCHITECTURE.md): runtime authority, secret-store/enterprise resolution boundary, separate volume services and webhook backends.
- [Secret endpoint availability](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/handlers/secrets.go): authenticated requests still require the configured backend/flag.
- [Open-source TCP firewall](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/tcpfirewall/proxy.go): `SupportsBYOP` returns false.
- [Orchestrator proxy rejection](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/server/sandboxes.go): unsupported egress proxy configurations are rejected.
- [SDK network contracts](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/sandboxApi.ts): documents open-source proxy restrictions and replacement semantics for network updates. This moving source is supplementary; shipped behavior must match the pinned runtime.

This was a read-only architecture/source review plus a documentation change.
No new production, security, remote-host or hardware acceptance result is claimed.

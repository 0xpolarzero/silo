# Network micro-review

Scope: `app/SiloUI/src-tauri/src/network.rs`.

Read-only source review. Checked the two earlier comprehensive reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for existing findings. No builds, tests, app launches, or live VM operations were performed.

## NETWORK-1: Failed removals disappear from refreshes and lose background retries

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/network.rs:538`, `:713`, `:918`.
- **Trigger:** Remove the last enabled mapping on a running VM while `port_remove` fails and the runtime retains its published listener. Let runtime controls recover, then refresh network state without restarting the VM.
- **Evidence:** Removal first persists `enabled = false` at line 918. Reconciliation returns the removal failure, and `apply_saved` supplies it to the immediate observation. Subsequent `state_with` observations supply an empty failure map (lines 758–771). At lines 538–539, `observe` skips every disabled mapping without a supplied failure, even when `published` still contains that port. Its discovered-listener row remains `configured: false`, `state: "unpublished"`, with no host port. The scheduler selects only enabled mappings at line 713; when this is the final mapping, it returns at lines 716–717 without retrying removal. When another enabled mapping exists on the same VM, that VM remains eligible for reconciliation, so the missing retry specifically affects VMs with only removal tombstones.
- **Consequence:** A live loopback forward remains accessible while the refreshed panel represents the guest service as unpublished and removes its Remove control. Refresh cannot converge the last failed removal; VM restart or another explicit mutation is required.
- **Suggested fix:** Include pending removal mappings in reconciliation scheduling. During ordinary observation, retain a configured removal-pending row whenever a disabled mapping still has a live forward, and show that access remains active until removal is confirmed.
- **Test that would catch it:** Use a running-VM/control-socket fixture with one published port. Make the first removal fail without deleting its listener, then make subsequent operations succeed. A fresh observation must preserve a visible removal-pending row and retry action. A scheduled refresh must issue `port_remove` despite having no enabled mappings, and the listener must disappear after acknowledgement.

## NETWORK-2: Recreated sandboxes inherit deleted sandboxes' port publications

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/network.rs:48`, `:651`, `:962`.
- **Trigger:** Publish a port for sandbox A named `dev`, stop and delete A, then create and start sandbox B with a different immutable ID but the same name.
- **Evidence:** `Mapping` stores `workspace: String` and no VM ID (lines 47–53). Saving persists the supplied workspace name (line 853). Reconciliation selects desired mappings solely by that name (line 651); `reconcile_started` also selects by name (line 962). The deletion path in `runtime.rs:5142–5154` removes runtime, metadata, lifecycle state, secrets, GitHub state, disks, and checkpoints, but does not remove network mappings. The configuration-recovery removal path likewise has no network cleanup. `network.json` lives beside the machine metadata, outside the deleted VM's volume directory (line 141). Thus the saved enabled entry remains and the new VM's start sends `port_add` for it.
- **Consequence:** A different sandbox acquires the old sandbox's enabled forwarding policy, host-port selection, and website scheme without a new publishing action. Any service B subsequently runs on that guest port is forwarded to the host. The new immutable ID used for the browser hostname does not prevent reuse of the saved forwarding policy.
- **Suggested fix:** Bind saved mappings to the immutable VM ID and resolve names only when calling the runtime. Migrate legacy name-only entries against existing metadata, and remove deleted-VM entries through both ordinary deletion and recovery paths.
- **Test that would catch it:** Persist an enabled mapping for A, delete A through the configuration path, create B under the same name with a new ID, and start B. Assert that no inherited `port_add` occurs and B has no configured port until explicitly published. Retain a positive case proving that stopping and starting A preserves A's mapping.

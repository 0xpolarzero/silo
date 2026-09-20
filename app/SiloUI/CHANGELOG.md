# silo-ui

## 0.7.1

### Minor Changes

- 7e7fb3e: Add an optional interactive Linux desktop to new or existing sandboxes, with automatic or manual startup and a dedicated desktop viewer. Closing the viewer keeps graphical applications running.
- 2e6d920: Automatically reclaim unused local workspace disk space after seven days and before stopping when the last reclaim was at least a day ago, with bounded attempts that do not prevent shutdown. Add a Storage panel showing host disk allocation, workspace usage, manual reclamation, and a collapsed history of the latest 50 attempts, with measurement tooltips and reclaim progress. Fix a runtime bug that shortened disk images when reclaiming their unused tail.
- 6d5467c: Search all retained sandbox logs, browse older pages, filter by time and source, follow new output, inspect surrounding records, and export matching diagnostics with timestamps and computer, sandbox, source, and session details. Failed activities link to their diagnostic time window; unavailable computers show explicit errors.

### Patch Changes

- 2e6d920: Add Linux desktop directly from a sandbox's more-actions menu, with automatic startup enabled by default.
- 7acd6e7: Distinguish local and remote VMs with monitor and server icons, keeping the remote computer name in a neutral badge. Show one SSH badge: neutral for host-only access and blue with a network icon for access from other computers. Keep address copying in the expanded SSH controls.
- 020a8e0: Keep the Logs view focused on records and actionable errors by removing retention and search-scope commentary.
- 6b32d76: Distinguish local and remote VMs with monitor icons and a network marker, and local and network SSH access with server icons and the existing top-right network marker pattern. Keep SSH badge text compact, with scope explained in tooltips. Show the host computer name on remote VM rows, wrap connection labels and actions in narrow windows, and keep SSH settings expandable in the read-only website demo.
- e8c507c: Add a shortcut at the end of GitHub repository search results to authorize more repositories, and automatically load them when returning from GitHub.
- e8c507c: Clear GitHub settings progress when a newer settings revision completes with the same result as the previous save.
- 589702d: Add a refresh button before the Repositories caret in Files. Manual refresh bypasses cached repository scans on local and connected computers and shows progress while loading.
- 4d864a9: Match remote computer badges to local VM badges with the same rounded, borderless muted appearance.
- 77d34d1: Allow the main desktop window to search retained logs and export or cancel log exports.
- 7e7fb3e: Route Quit Silo on macOS through the shutdown flow so local sandboxes stop and pending settings save before the app exits.
- e5807fe: Make source and date filters optional, with removable chips and a Clear action. Simplify the logs empty state and show date controls only when adding or editing a date filter.
- 2e6d920: Group sandbox menu actions with desktop access, Restart and Storage first, followed by configuration actions and Delete.
- 12696cd: Use plain Search logs, Copy, and Export labels, with tooltips explaining what is copied or saved.
- 589702d: Refresh repository rows automatically while Silo is visible, so changes inside local VMs appear without switching windows. Avoid overlapping periodic reads when a scan is slow.
- 777e109: Remove the start-VM caption from waiting ports in the Network view.
- 72e4bb8: Retain runtime, execution, and kernel logs together for up to seven days within a 250 MiB sandbox budget. Rotate daily or at 10 MiB, remove the oldest segments first, and apply the same limits to kernel output and stopped sandboxes.
- 0a2e60c: Keep sandbox controls beside the name and status when there is room, instead of forcing them onto another line in moderately narrow windows.
- 6b32d76: Keep sidebar icons at the same position and size when expanding or collapsing the sidebar. Use compact circular backgrounds behind network corner markers so they remain legible without obscuring the VM or SSH icon.

## 0.7.0

### Minor Changes

- 7e7fb3e: Add an optional interactive Linux desktop to new or existing sandboxes, with automatic or manual startup and a dedicated desktop viewer. Closing the viewer keeps graphical applications running.
- 2e6d920: Automatically reclaim unused local workspace disk space after seven days and before stopping when the last reclaim was at least a day ago, with bounded attempts that do not prevent shutdown. Add a Storage panel showing host disk allocation, workspace usage, manual reclamation, and a collapsed history of the latest 50 attempts, with measurement tooltips and reclaim progress. Fix a runtime bug that shortened disk images when reclaiming their unused tail.
- 6d5467c: Search all retained sandbox logs, browse older pages, filter by time and source, follow new output, inspect surrounding records, and export matching diagnostics with timestamps and computer, sandbox, source, and session details. Failed activities link to their diagnostic time window; unavailable computers show explicit errors.

### Patch Changes

- 2e6d920: Add Linux desktop directly from a sandbox's more-actions menu, with automatic startup enabled by default.
- 7acd6e7: Distinguish local and remote VMs with monitor and server icons, keeping the remote computer name in a neutral badge. Show one SSH badge: neutral for host-only access and blue with a network icon for access from other computers. Keep address copying in the expanded SSH controls.
- 020a8e0: Keep the Logs view focused on records and actionable errors by removing retention and search-scope commentary.
- 6b32d76: Distinguish local and remote VMs with monitor icons and a network marker, and local and network SSH access with server icons and the existing top-right network marker pattern. Keep SSH badge text compact, with scope explained in tooltips. Show the host computer name on remote VM rows, wrap connection labels and actions in narrow windows, and keep SSH settings expandable in the read-only website demo.
- e8c507c: Add a shortcut at the end of GitHub repository search results to authorize more repositories, and automatically load them when returning from GitHub.
- e8c507c: Clear GitHub settings progress when a newer settings revision completes with the same result as the previous save.
- 589702d: Add a refresh button before the Repositories caret in Files. Manual refresh bypasses cached repository scans on local and connected computers and shows progress while loading.
- 4d864a9: Match remote computer badges to local VM badges with the same rounded, borderless muted appearance.
- 77d34d1: Allow the main desktop window to search retained logs and export or cancel log exports.
- 7e7fb3e: Route Quit Silo on macOS through the shutdown flow so local sandboxes stop and pending settings save before the app exits.
- e5807fe: Make source and date filters optional, with removable chips and a Clear action. Simplify the logs empty state and show date controls only when adding or editing a date filter.
- 2e6d920: Group sandbox menu actions with desktop access, Restart and Storage first, followed by configuration actions and Delete.
- 12696cd: Use plain Search logs, Copy, and Export labels, with tooltips explaining what is copied or saved.
- 589702d: Refresh repository rows automatically while Silo is visible, so changes inside local VMs appear without switching windows. Avoid overlapping periodic reads when a scan is slow.
- 777e109: Remove the start-VM caption from waiting ports in the Network view.
- 72e4bb8: Retain runtime, execution, and kernel logs together for up to seven days within a 250 MiB sandbox budget. Rotate daily or at 10 MiB, remove the oldest segments first, and apply the same limits to kernel output and stopped sandboxes.
- 0a2e60c: Keep sandbox controls beside the name and status when there is room, instead of forcing them onto another line in moderately narrow windows.
- 6b32d76: Keep sidebar icons at the same position and size when expanding or collapsing the sidebar. Use compact circular backgrounds behind network corner markers so they remain legible without obscuring the VM or SSH icon.

## 0.6.3

### Patch Changes

- 3eacd00: Use standard Git and Git LFS transfers for explicit pushes, including empty files and historical LFS data. Reuse a bounded publishing cache without giving sandboxes GitHub write access. Keep push progress and results across remote disconnections, prevent duplicate requests, and identify unknown outcomes after a host restart. Update Silo on both computers to use the new remote push flow.
- 298879d: Keep the status menu fully visible when sandbox content changes or loads, including the Open Silo and Quit controls.
- a1c0565: Place the smaller crash Dismiss button beside the sandbox error message.

## 0.6.2

### Patch Changes

- 826fae1: Allow updating and quitting when a sandbox has crashed. Add Dismiss to acknowledge a sandbox crash and show it as stopped without deleting its data or starting it; later crashes remain visible.

## 0.6.1

### Patch Changes

- 2cfc0f5: Show the failed object, process exit status, transferred bytes, and bounded runtime diagnostics when a repository push cannot copy committed objects from its sandbox. Report a file-size limit only when the transfer process receives the corresponding signal.
- 261c792: Keep normal HTTPS certificates for destinations that do not receive sandbox secrets, fixing TLS failures in SSH-connected coding agents that discard inherited CA settings. Secret destinations retain TLS interception, and live secret changes update which destinations are intercepted.
- b4de71a: Show the required SSH username beside each connection address and clear command copy feedback automatically instead of leaving “Command copied” in the menu. Place SSH controls before Start/Stop in sandbox rows.

## 0.6.0

### Minor Changes

- Open sandbox SSH access from the Overview page, with automatically generated connection keys, editable ports, copyable addresses, and optional LAN or VPN access. Local access remains available when network access is enabled.
- Manage SSH access on connected computers. SSH access stays within the sandbox’s running lifetime and closes when its owning Silo app exits.
- Keep sandbox controls compact: Terminal, Editor, Start/Stop, and SSH stay visible; Restart, Edit, Duplicate, and Delete move into an icon-labeled menu. SSH badges provide quick address copying.
- Show sandbox counts by computer location and simplify Activity cards, waiting-port messages, and GitHub settings.
- Keep update notices concise and place manual installation instructions in an expandable section while preserving automatic Debian installation.

## 0.5.2

### Patch Changes

- 5b65788: Align the macOS window controls with the sidebar and navigation buttons across macOS SDK versions.

## 0.5.1

### Patch Changes

- fba6ede: Update Debian installations directly in Silo with system authentication, package-list refresh, progress, and restart. Check for updates when returning to Silo, with throttling and offline retries. Older installations need this release installed once before the new Update action is available.

## 0.5.0

### Minor Changes

- a188454: Connect a personal GitHub token alongside GitHub OAuth and choose the connection for each VM. Tokens stay on the host, support accounts with no repositories, and provide their full GitHub permissions. Disconnected methods are unavailable without switching VMs to another connection. Existing VMs running an older Silo runtime need one restart before using a personal token.

### Patch Changes

- e2faa5d: Remove the redundant caption beneath network ports waiting for a service.

## 0.4.4

### Patch Changes

- Fix AI agents disconnecting after reading secret placeholders. Unmatched placeholders now pass unchanged, while real credentials remain restricted to allowed domains. Update Silo on every computer running your VMs, then restart those VMs to apply the fix.

## 0.4.3

### Patch Changes

- Fix AI agents losing their connection after reading secret placeholders. Requests to other domains now carry placeholders unchanged; real credentials are still substituted only for allowed domains. Update Silo on each computer that runs your VMs, then restart existing VMs to apply the fix.

## 0.4.2

### Patch Changes

- dc7b891: Include curl in newly created VMs. Existing VMs keep their installed packages; run `apt-get update && apt-get install -y curl` inside an existing VM if needed.

## 0.4.1

### Patch Changes

- Add a Linux Menu button with Alt/F10 access and Escape focus restoration. Find update checks, downloads, installation, retries, and installer links through Command-K or Control-K, with confirmation before stopping running sandboxes.

## 0.4.0

### Minor Changes

- Add a Linux application menu accessible from the Menu button, Alt, or F10. Escape dismisses the menu and returns keyboard focus to the application.

  Find update checks, downloads, installation, retries, and manual installer links through Command-K or Control-K. Available commands follow update progress and preserve confirmation before stopping running sandboxes.

## 0.3.3

### Patch Changes

- Check for updates shortly after launch, retry failed checks automatically, and check promptly after automatic checks are re-enabled or the computer resumes. Preserve pending updates and download retries during background checks.

  Clarify the Linux Software Updater instructions and label the GitHub installer link accurately. Prevent edits during installation so settings are saved before Silo restarts.

## 0.3.2

### Patch Changes

- Fix Cancel and Open browser again being blocked by desktop permissions during GitHub connection. Show connection errors in onboarding so failed recovery actions are visible.

- Add terminal and code editor buttons beside sandbox lifecycle controls in the overview. The editor button lets you choose a sandbox folder.

## 0.3.1

### Patch Changes

- Allow completing setup without a sandbox, deleting the last sandbox, and creating one later. Preserve intentionally empty setup drafts across relaunches.

  Allow Quit after first-time runtime setup failed before any VM was created, even when an older version left a directory in place of the runtime alias. Continue checking shutdown whenever runtime state or an active worker exists.
- Add Cancel and Open browser again while connecting GitHub. Cancel stops the pending authorization without disconnecting an existing account, and retrying cannot be overwritten by a cancelled attempt. Keep the existing Continue flow available during setup.

## 0.3.0

### Minor Changes

- 2409cc0: The Linux installer now offers updates through Software Updater. Enable Silo's signed software source once to receive future releases with your other application updates. Package upgrades ask you to quit Silo first so local VMs are not interrupted by replacing the application.

## 0.2.3

### Patch Changes

- Show available updates during setup, with update controls accessible without completing onboarding.
- Fix runtime initialization during sandbox recovery and secure Silo's shared directory when it already has group-write permissions. Report the conflicting path when a runtime alias is occupied, preserving existing data.

  Enable text selection in activity entries and add a button to copy each activity's title and details.

## 0.2.2

### Patch Changes

- 861a356: Correct Silo Help to explain CPU and memory edits, remote computer setup, and how closing or quitting affects running sandboxes.
- fde17c1: Choose smaller presets or custom whole-number values for VM CPUs, memory, and new VM disks. Custom resource settings persist across restarts, with limit, ceiling, and storage validation. Existing VM disks remain read-only.

## 0.2.1

### Patch Changes

- Manage another computer’s VMs over SSH from the Computers settings category. Connect to a computer running Silo to create, start, stop, edit, and delete its VMs, and open their terminals and files.

  Remote management requires Silo to remain running on the owning computer, remote management to be enabled, and SSH access to that account. Quitting Silo stops its local VMs and disconnects remote sessions; VMs owned by other computers keep running.

  This release includes the remote computer features from the unpublished 0.2.0 build.

## 0.2.0

### Minor Changes

- 9e7845d: Manage another computer’s VMs over SSH from the new Computers settings category. Connect to a computer running Silo to create, start, stop, edit, and delete its VMs, and open their terminals and files.

  Remote management requires Silo to remain running on the owning computer, remote management to be enabled, and SSH access to that account. Quitting Silo stops its local VMs and disconnects remote sessions; VMs owned by other computers keep running.

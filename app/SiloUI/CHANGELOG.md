# silo-ui

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

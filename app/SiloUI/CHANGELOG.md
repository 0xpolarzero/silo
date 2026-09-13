# silo-ui

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

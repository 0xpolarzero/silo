# Silo

<img src="assets/silo-logo.svg" alt="Silo" width="96">

Silo is a desktop app for creating and managing Linux development VMs on your computer and remote computers from one interface. It runs on macOS and Linux and connects over SSH to other computers running Silo.

Each sandbox is a persistent virtual machine powered by MicroSandbox, with its own CPU, memory, and disks. Start and stop local or remote sandboxes, work in your terminal or editor over SSH, browse project files, and open development services in your browser.

## Install

Download the package for your computer from [Silo releases](https://github.com/0xpolarzero/silo/releases).

| Platform | Requirements | Package |
| --- | --- | --- |
| macOS | Apple Silicon, macOS 14 or newer | DMG |
| Linux | x86-64 or ARM64, Ubuntu 24.04-compatible system; KVM access for local VMs | AppImage or `.deb` |

On macOS, open the DMG and drag Silo to Applications. The app is not notarized; first launch may require **System Settings → Privacy & Security → Open Anyway**. On Linux, make the AppImage executable and launch it, or install the Debian package with your package manager. MicroSandbox, the guest image, and Git tools are bundled.

This README describes the current source. Check the download's release notes for available features; remote computer management was added in [0.2.0](docs/releases/0.2.0.md) and is absent from 0.1.x.

## Start working

1. **Complete setup.** Silo checks dependencies, lets you choose your terminal and editor, and creates your sandboxes. Choose a name, CPU, memory, and disk sizes. GitHub connection is optional.
2. **Open a sandbox.** Use its controls to start it and open a terminal. Keep project files in `/workspace`; they survive stops, restarts, and app updates.
3. **Open your editor.** Browse **Files** and use a folder's editor action. Use Zed, or Visual Studio Code with its Remote SSH extension. The editor runs on your computer and connects to the sandbox over SSH.
4. **Open a development server.** Start the server inside the sandbox, listening on `0.0.0.0`, then use **Network → Add port** or connect a discovered port. Open the displayed local address when it becomes reachable. Adding a port does not start the server.

Use **Search or Jump To…** (`⌘K` on macOS, `Ctrl K` on Linux) to find pages and sandbox actions. Use **Add** above the sandbox list to create another sandbox. **Logs** shows runtime output; **Activity** shows operations and their results.

Stopping a sandbox preserves its disks. CPU and memory edits stop a running sandbox and take effect on its next start. Existing sandbox names and disk sizes cannot change.

Closing the window keeps Silo running when a status icon is available; otherwise it quits. **Quit stops Silo's local VMs**, preserves their disks, and leaves VMs on other computers running. A shutdown failure keeps the app open with an error.

## GitHub, secrets, and backups

- **GitHub:** connect your account and choose repository access for each sandbox. Access defaults to read-only; enable writes when needed. Set the Git author separately.
- **Secrets:** store API credentials in this computer's credential store and assign them to sandboxes and allowed HTTPS domains. Guests use placeholders that the runtime replaces in permitted requests. See [secret behavior and limits](docs/SiloUI-SECRETS.md).
- **Backup:** select local sandboxes and a destination. Silo stops selected running VMs, saves their disks and configuration, then attempts to restart them. Restore creates a new stopped VM and requires the same CPU architecture. Backups do not include the host credential store.

## Use another computer

Remote management requires Silo 0.2.0 or newer on both computers and SSH access to the owning computer.

1. On the computer hosting the VMs, enable SSH access (**Remote Login** on macOS), open **Settings → Computers**, enable **Allow remote management**, and copy the address.
2. On your computer, choose **Connect computer…** and paste the address. Follow the SSH authorization or key setup action if prompted.
3. Manage its sandboxes alongside local ones. Choose **Run on** when creating a sandbox to select its computer.

Keep Silo running on the owning computer. Connecting does not move or synchronize VMs, accounts, secrets, or backups. Manage those settings and backups on their owning computer. See [remote computers](docs/SiloUI-REMOTE-COMPUTERS.md) for details.

## Build from source

The app lives in [`app/SiloUI`](app/SiloUI), using React, TypeScript, Rust, and Tauri. Install Node.js 24, Python 3.11 or newer, Rust, and the host's Tauri prerequisites. Runtime preparation also requires Rust 1.94.0 and network access on a cold cache.

Native builds require GitHub App configuration even if you skip GitHub in the app. Follow [local setup](docs/SiloUI-RELEASES.md#local-setup), then run from the repository root:

```sh
npm --prefix app/SiloUI ci
npm --prefix app/SiloUI run desktop
```

`desktop` prepares the bundled runtime and launches the native app. `npm --prefix app/SiloUI run dev` only starts Vite; the normal browser entry requires Tauri and is not an interactive app preview.

See the [build and release guide](docs/SiloUI-RELEASES.md#local-setup) for local bundles and verification commands, and the [documentation index](docs/README.md) for implementation details. Add a [changeset](docs/SiloUI-RELEASES.md#while-making-changes) with user-visible app changes.

## Help

Open **Silo Help** in the app for the bundled guide. For a problem, check the operation's error details, **Logs**, and **Activity**, then [report an issue](https://github.com/0xpolarzero/silo/issues) with your Silo version, operating system, and steps to reproduce it. Remove credentials and private data from shared logs.

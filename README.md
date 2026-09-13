# Silo

<img src="assets/silo-logo.svg" alt="Silo" width="96">

Silo is a desktop app for managing Linux development VMs on your computer and remote computers from one place. It runs on macOS and Linux, with MicroSandbox powering the VMs.

Create a sandbox, open it in your usual editor or terminal, and connect to its development servers through the app. Manage GitHub access, API secrets, and backups in the same interface, without juggling VM commands and SSH configuration.

## Install

Download Silo from [Releases](https://github.com/0xpolarzero/silo/releases). The VM runtime, Linux image, and Git tools are included.

| Platform | Requirements | Installation |
| --- | --- | --- |
| macOS | Apple Silicon, macOS 14+ | Open the DMG and drag Silo to Applications. |
| Linux | x86-64 or ARM64, Ubuntu 24.04-compatible system | Install the `.deb` with your package manager and enable Silo updates when asked. Future releases appear in Software Updater. AppImage remains an optional portable download. |

On macOS, first launch may require **System Settings → Privacy & Security → Open Anyway** because the app is not notarized. Local VMs on Linux require KVM access.

## Start working

1. **Create a sandbox.** Follow setup to choose its name and resources, and your preferred terminal and editor. GitHub connection is optional. Use **Add → New sandbox** to create more later.
2. **Open your project.** Start the sandbox and open its terminal. Create or clone your project in `/workspace`; use an HTTPS URL for GitHub repositories. Browse **Files** to open a folder in your code editor.
3. **Open your development server.** Run it inside the sandbox, listening on `0.0.0.0`. In **Network**, connect a discovered port or choose **Add port**, then open the displayed address.

Your files survive stops, restarts, and app updates. Choose names and disk sizes carefully: they cannot change later. CPU and memory edits stop the sandbox and apply on its next start.

## Use another computer

Install Silo on both computers. You can connect during setup without creating local VMs.

1. On the computer hosting the VMs, enable SSH access (**Remote Login** on macOS). In **Settings → Computers**, enable **Allow remote management** and copy the address.
2. On your computer, choose **Add → Connect computer…**, paste the address, and follow any SSH setup prompts.
3. Use its sandboxes alongside your local ones. Choose **Run on** when creating a sandbox to select its computer.

Keep Silo running on the computer hosting the VMs. Manage its GitHub account, secrets, and backups there. See [remote computer setup and troubleshooting](docs/SiloUI-REMOTE-COMPUTERS.md) for details.

## GitHub, secrets, and backups

- **GitHub:** connect your account and choose which repositories each sandbox can access. Access starts read-only; enable writes when needed.
- **Secrets:** add an API credential, then choose its sandboxes and allowed HTTPS domains. Credentials are stored in your computer's credential store. See [how secrets work](docs/SiloUI-SECRETS.md).
- **Backup:** open **Backup** to save local sandboxes or restore an archive as a new sandbox. Backups temporarily stop selected running VMs and exclude your computer's credential store. See [backup and restore details](docs/SiloUI-RUNTIME-BACKUP-FINDINGS.md#backup-and-restore).

## Everyday controls

- **Find a page or action:** use **Search or Jump To…** (`⌘K` on macOS, `Ctrl K` on Linux).
- **Close the window:** Silo keeps running if a status icon is available; otherwise it quits.
- **Quit Silo:** stops this computer's Silo VMs and preserves their files. VMs on other computers keep running.
- **Troubleshoot:** check the error details, **Logs**, and **Activity**. On macOS, open **Help → Documentation** for the built-in guide. To [report an issue](https://github.com/0xpolarzero/silo/issues), include your app version, OS, and reproduction steps. Remove private data from shared logs.

## Development

The React, TypeScript, Rust, and Tauri app lives in [`app/SiloUI`](app/SiloUI). Follow the [development setup](docs/SiloUI-RELEASES.md#local-setup) for prerequisites, GitHub App configuration, build commands, and tests. Browse the [documentation index](docs/README.md) for implementation details.

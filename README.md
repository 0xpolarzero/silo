# Silo

<img src="assets/silo-logo.svg" alt="Silo" width="96">

Silo is a desktop app for managing Linux development VMs on your computer and remote computers from one place. It runs on macOS and Linux, with MicroSandbox powering the VMs.

Create a sandbox, open it in your usual editor or terminal, and connect to its development servers through the app. Manage GitHub access, API secrets, and backups in the same interface, without juggling VM commands and SSH configuration.

https://github.com/user-attachments/assets/4e9cedd1-60a5-40d3-ad60-81cd17d127be

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

## Build from source with your own GitHub App

Use this path if you want to own the GitHub connection as well as run Silo locally. You create a GitHub App under your account, put its configuration in an ignored local file, and build Silo with it. Silo's publisher has no ownership of that registration or independent installation access through it. You still need to trust the code you build and run.

You do not need to host a server, create a personal access token, or generate an App private key. Silo talks directly to GitHub and stores user credentials in macOS Keychain or Linux Secret Service. Native builds currently require GitHub App configuration even if you plan to skip GitHub during onboarding.

### 1. Install the build tools

Build on the computer where you will run Silo: Apple Silicon macOS 14+, or x86-64/ARM64 Linux compatible with Ubuntu 24.04. Cross-compilation is not covered here.

Install [Node.js 24](https://nodejs.org/en/download), Python 3.11 or newer, Git, and [Rust through rustup](https://rustup.rs/). Install the pinned Rust toolchain used by the bundled VM runtime:

```sh
rustup toolchain install 1.94.0 --profile minimal
```

**macOS:** install Apple's command-line tools if you do not already have them:

```sh
xcode-select --install
```

**Ubuntu 24.04:** install the native build and packaging dependencies:

```sh
sudo apt update
sudo apt install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libdbus-1-dev libclang-dev libcap-ng-dev cmake \
  libfuse2t64 squashfs-tools file
```

Linux needs a working desktop credential store implementing Secret Service, such as GNOME Keyring, for GitHub login. Running local VMs also requires hardware virtualization and access to `/dev/kvm`; compilation alone does not establish that KVM works. See [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/) for OS setup details.

### 2. Get the source

```sh
git clone https://github.com/0xpolarzero/silo.git
cd silo
rustup override set 1.94.0
npm --prefix app/SiloUI ci
```

Run the remaining commands from this `silo` directory. The first native build downloads and compiles the bundled runtime and prepares the guest image, so it needs internet access and can take substantially longer than later builds.

### 3. Create your GitHub App

Open [GitHub → Settings → Developer settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new). This guide assumes you are using your personal account and repositories.

Fill in these settings:

| GitHub field | What to enter |
| --- | --- |
| GitHub App name | A unique name, such as `Silo-yourusername-dev`. |
| Homepage URL | `https://github.com/0xpolarzero/silo` or your own fork's URL. |
| Callback URL / Redirect URI | `http://127.0.0.1/github/callback` |
| Allow wildcard matching, if shown | Leave disabled. |
| Expire user authorization tokens | Leave enabled; Silo renews them automatically. Check **Optional features** after creation if this setting is not on the form. |
| Request user authorization (OAuth) during installation | Leave disabled; Silo starts authorization itself. |
| Enable Device Flow | Leave disabled. |
| Setup URL | Leave empty. |
| Webhook → Active | Uncheck it; leave the webhook URL empty. |
| Where can this GitHub App be installed? | **Only on this account** for your personal repositories. |

The callback is a temporary listener on the computer running Silo. Silo supplies its port when opening the browser; do not copy a port or authorization URL from a previous login attempt into the registration. This portless registration was exercised in Silo's [live OAuth audit](docs/SiloUI-OAUTH-RELEASE-AUDIT.md#live-pkce-reproduction).

Under **Repository permissions**, choose the access you need:

| What you want to do | Permission |
| --- | --- |
| Clone and read repository code | **Contents: Read-only** |
| Also push commits | **Contents: Read & write** instead |
| Push changes to GitHub Actions workflow files | Also **Workflows: Read & write** |
| Work with issues or pull requests | Also **Issues** and/or **Pull requests**, with Read-only or Read & write as needed |
| Use other GitHub features from a VM | Enable their corresponding repository permissions, such as Actions or Packages. |

Leave **Account**, **Organization**, and **Enterprise** permissions at **No access**. Silo currently accepts repository permissions only. GitHub includes mandatory read-only Metadata access. The App's permissions are the maximum Silo can grant: each VM starts read-only, and enabling changes in Silo cannot exceed what you approved here.

Click **Create GitHub App**. Creating it does not yet install it on your repositories; Silo will guide you through installation when you connect. GitHub's [registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) explains the form in more detail.

**Organization repositories or other users:** a private personal App only works for its owner and cannot be installed on another account. To use the same registration on organization repositories, choose **Any account** and obtain any required organization approval. This makes the App installable by others, not their repositories public. You still own the App and its credentials. Teams can instead register it under their organization, subject to its policies.

### 4. Add your App configuration to Silo

On your new App's **General** settings page, find these three values:

| Silo setting | Where to find it |
| --- | --- |
| `SILO_GITHUB_APP_SLUG` | The last part of the App settings URL. For `github.com/settings/apps/silo-alex-dev`, use `silo-alex-dev`. |
| `SILO_GITHUB_CLIENT_ID` | **Client ID**, not the numeric App ID. |
| `SILO_GITHUB_CLIENT_SECRET` | Click **Generate a new client secret**, then copy the generated value. This is not an App private key. |

Create the configuration file once:

```sh
cp app/SiloUI/github-build.example.json app/SiloUI/github-build.local.json
chmod 600 app/SiloUI/github-build.local.json
```

Open `app/SiloUI/github-build.local.json` in your editor and replace **all three values**, including the example's existing App slug and client ID:

```json
{
  "SILO_GITHUB_APP_SLUG": "silo-yourusername-dev",
  "SILO_GITHUB_CLIENT_ID": "YOUR_CLIENT_ID",
  "SILO_GITHUB_CLIENT_SECRET": "YOUR_CLIENT_SECRET"
}
```

Keep the quotes and use your actual values. The file is ignored by Git; do not commit or share it. Silo reads it automatically when compiling. Previously exported `SILO_GITHUB_*` environment variables override the file, so unset those if you configured a different App earlier.

The client secret is embedded in your compiled app and can be extracted from it. Keep this build for your own use; do not treat that embedded value as a confidential credential. No App private key is needed or bundled. See the [credential audit](docs/SiloUI-OAUTH-RELEASE-AUDIT.md) for the precise security model.

### 5. Run or build Silo

To run the native app while developing:

```sh
npm --prefix app/SiloUI run desktop
```

This prepares the runtime and opens Silo. Keep the terminal running. `npm run dev` alone only opens the browser UI preview; it cannot run VMs or complete native GitHub setup.

For an optimized app you can launch without the development terminal, use the command for your platform. These commands disable updater artifact signing, so you do not need the project's release signing keys.

**macOS:**

```sh
npm --prefix app/SiloUI run desktop:build -- --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
open app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app
```

**Linux:**

```sh
npm --prefix app/SiloUI run desktop:build -- --bundles appimage \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Open `app/SiloUI/src-tauri/target/release/bundle/appimage/` and launch the generated `.AppImage` for your architecture. If necessary, enable **Allow executing file as program** in its file properties. Use this AppImage for a personal source build rather than enrolling it in Silo's official Debian update source.

### 6. Connect and use your repositories

1. In the app you just built, choose **Connect GitHub** during setup or from its GitHub settings.
2. In the browser on that same computer, sign in with the account that owns your private App. Confirm that GitHub shows **your App's name**.
3. Authorize it. If it is not installed yet, Silo opens the installation page; choose **Only select repositories** and select the repositories you want available.
4. Return to Silo. Choose repositories for each VM, then enable **Allow GitHub changes** only where needed. Clone over HTTPS inside the VM; Silo supplies credentials automatically.

If you previously connected using an official Silo build, disconnect that connection before connecting your own App. Source builds currently share the same application identity and local data locations with official builds; changing the build does not create a separate set of VMs or settings. Quit an existing Silo instance safely before launching another build.

### Updating and troubleshooting your build

**Update by rebuilding:** pull new source, install its dependencies, and repeat your build command. Keep `github-build.local.json` in place. Resolve any local source changes before pulling.

```sh
git pull --ff-only
npm --prefix app/SiloUI ci
```

Do not install an official Silo update over this build: it would replace your compiled GitHub App configuration with the publisher's. Turn off **Automatically check for updates** in Silo's Updates settings. Disabling updater artifact signing during the build does not disable update checks.

| Problem | What to check |
| --- | --- |
| Build reports missing or invalid GitHub configuration | Check all three values in `github-build.local.json`, including accidental whitespace and old environment overrides. Rebuild after editing. |
| GitHub authorization page returns 404 | Check the compiled client ID and App visibility. A private personal App only allows its owner to sign in. |
| Browser cannot return to Silo | Keep Silo running, use the browser on the same computer, check the callback setting above, then cancel and start a fresh connection. |
| Repository is missing | Add it to your App installation in GitHub settings; organization approval may be required. Refresh the repository list in Silo. |
| Reads work but writes fail | Check both the GitHub App's permissions and that VM's **Allow GitHub changes** setting. Approve updated installation permissions on GitHub if you changed them. |

The React/TypeScript frontend and Rust/Tauri backend live in [`app/SiloUI`](app/SiloUI). For tests, distribution signing, and maintainer releases, see the [development and release guide](docs/SiloUI-RELEASES.md). Browse the [documentation index](docs/README.md) for implementation details.

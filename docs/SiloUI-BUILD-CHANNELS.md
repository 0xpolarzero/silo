# Build channels: production and development

Only two Silo builds exist, and they never share state.

| | Production | Development |
|---|---|---|
| Identifier | `org.silo.preview` | `org.silo.dev` |
| Product name | Silo | Silo Dev |
| Built by | `desktop:build`, the release workflows, installed packages | `npm run desktop` (`tauri dev`), `npm run desktop:build:debug`, any `--debug` build |
| Configuration | `src-tauri/tauri.conf.json` | `src-tauri/tauri.conf.json` merged with `src-tauri/tauri.dev.conf.json` |
| Updates | Release feed | None. Silo Dev never updates itself or installs a production release |

`scripts/build_desktop.py` adds the development configuration whenever `--debug`
(or `-d`) is passed and never otherwise. The previous `tauri.debug.conf.json` was
folded into `tauri.dev.conf.json` (ad-hoc signing included), so there is no third
identity. A production identifier, path, or name must never change: existing
users' data lives there.

## One source of truth

`src-tauri/src/channel.rs` derives every host-visible name from the bundle
identifier embedded in the running binary (`channel::init` runs first in `main`,
including for the `--remote-bridge`, `--remote-guest` and editor-transport modes
that run without a window). Only the exact production identifier selects
production; any other identifier is treated as development, so a stray build can
never touch production data. Unit tests pin every production name to its released
value and require every development name to differ.

Development and packaging scripts read this API through the standalone
`scripts/channel_names.rs` exporter. The Python adapter compiles it in a temporary
directory, reads its JSON output, and deletes the executable; the Node adapter
uses the same Python adapter. This requires Rust and Python 3.11 or newer but no
Tauri build, GitHub configuration, or access to application state. It avoids a
second registry of names or a parser tied to Rust source formatting. Linux
verification harnesses use the same adapter for runtime aliases, including
non-production identifiers, so Dev fixtures look under the Dev private home. Production app bundle roots, disk-image volume names, release asset names and
package identity checks also read the exporter; production output names stay
unchanged. Static Tauri
configuration and documentation examples remain pinned by channel tests.

## Shared state that is now per channel

| State | Production (unchanged) | Development |
|---|---|---|
| App data, config, cache, logs, WebView storage | `<app dirs>/org.silo.preview` | `<app dirs>/org.silo.dev` (Tauri keys these by identifier) |
| Runtime alias dirs `~/.silo/<hash>` | hash of production storage | `~/.silo-dev/<hash>` |
| Silo private home `~/.silo` (editor workspace files, desktop sockets, remote-management state `desktop-remote/`, control socket) | `~/.silo` | `~/.silo-dev` |
| Keychain: GitHub (`account`, `personal-token`, `runtime-grants`) | `org.silo.Silo.github` | `org.silo.dev.github` |
| Keychain: secret values | `org.silo.Silo.secrets` | `org.silo.dev.secrets` |
| Remote-management bridge link | `~/.local/bin/silo-remote` | `~/.local/bin/silo-remote-dev` |
| Forced command in an installed remote key | `exec ~/.local/bin/silo-remote --remote-bridge` | `exec ~/.local/bin/silo-remote-dev --remote-bridge` |
| Remote key comment | `Silo remote management` | `Silo Dev remote management` |
| SSH aliases for other computers' sandboxes | `silo-remote-<host>-<vm>` | `silo-dev-remote-<host>-<vm>` |
| SSH config/known_hosts/keys | under the private homes above | under `~/.silo-dev` |
| `~/.ssh/config` | one `Include` line per private home, so each channel adds its own line | |
| Native app menus, dialogs, tray labels and shutdown inhibitor | `Silo` | `Silo Dev` |
| VS Code profile | `Silo` | `Silo Dev` |
| Linux autostart entry and desktop id | `org.silo.preview.desktop` ("Silo Preview") | `org.silo.dev.desktop` ("Silo Dev") |
| Linux tray id, notification desktop entry | `org.silo.preview`, `Silo` | `org.silo.dev`, `Silo Dev` |
| macOS login item, notification permission, single-instance lock | keyed by bundle identifier | keyed by bundle identifier (verified: the plugin's socket and D-Bus name include it) |
| Updater | release feed | disabled |

Left shared on purpose: the `.silo-backup` archive format (so Dev can import
Production exports), `~/.ssh/authorized_keys` on a computer being managed (keys
are matched by blob), the user's own VS Code/Zed installs, and `~/.ssh/known_hosts`.

Unit tests and the isolation rules assume both channels can run at the same time
on one computer; they cannot collide on a socket, lock, link, key, or service name.

## Remote management and identity

Silo Dev always has its own remote-management identity: its own host id, control
socket, and remote-management switch (off by default). Computers that Dev
manages, and computers that manage Dev, see it as a separate computer.

- Dev as the managed computer: enabling remote management links
  `~/.local/bin/silo-remote-dev`. A production Silo on another computer cannot
  reach it, because installed keys only run the production bridge. Use a Dev build
  on the controlling side.
- Dev as the controller with its own key: Dev installs `Silo Dev remote management`
  keys whose forced command is the dev bridge, so the remote computer needs Silo Dev.
- Dev as the controller with the key copied from production (see below): the key's
  existing authorized_keys entry on the remote computer runs the production bridge
  there, so Dev reaches the production Silo on that computer without any re-setup.
  Driving or changing sandboxes on a remote production Silo is still production
  state; automation and tests must not do it.

## Copying production configuration into Dev

```sh
npm --prefix app/SiloUI run dev:import-production-settings -- --dry-run
npm --prefix app/SiloUI run dev:import-production-settings
```

One-time and explicit. Production is only read; the command refuses to run while
Silo Dev is running, lists what it will copy, and asks before replacing anything
Dev already has (previous files are kept as `*.bak-<time>`). Re-running is safe.
Values are never printed.

Imported private files and their backups use `0600`, including when the previous
Dev file had broader permissions. Backups use the same atomic writer as imports:
[Node's file writer](https://nodejs.org/docs/latest-v24.x/api/fs.html#fswritefilesyncfile-data-options)
accepts creation permissions, while
[the copy API's mode](https://nodejs.org/docs/latest-v24.x/api/fs.html#fscopyfilesyncsrc-dest-mode)
controls copy flags rather than permissions. Public SSH keys use `0644`.

Copied:

- App preferences and onboarding completion: theme, reduce motion, notification
  settings, terminal/editor/browser choices (`settings.json`, allow-list only).
- GitHub personal access token (Keychain duplicate under `org.silo.dev.github`).
  The OAuth login is not copied unless `--include-github-oauth` is given: GitHub
  rotates refresh tokens, so whichever channel refreshes first invalidates the
  other's copy and logs it out. Connect GitHub in Dev instead, or accept that risk.
- Secret definitions and values (Keychain duplicate), with no sandbox assignments,
  pending work, errors, or activity.
- Remote computers: the saved list and the client key (`id_ed25519`, `.pub`) that
  reaches them. Dev keeps or creates its own host id and leaves remote management off.

Never copied: sandboxes, VMs, checkpoints, disks, volumes, backups and history, the
MicroSandbox home and runtime, per-sandbox network/SSH settings, startup-sandbox and
launch-at-login choices, update preferences, derived SSH configs, `~/.ssh`, VS Code
profiles. Dev recreates editor and SSH integration on first use.

macOS uses the `security` tool: the Keychain may ask you to allow access to the
production items, and Dev asks once before reading items the tool created. Linux
uses `secret-tool` (not exercised against a live secret service here).

## Running both

Launch the exact bundle you mean (`Silo.app` or `Silo Dev.app`). Close Dev before
running the import. Clean up dev-only files by deleting `<app dirs>/org.silo.dev`,
`~/.silo-dev`, `~/.local/bin/silo-remote-dev`, the `org.silo.dev.*` Keychain items,
the `Silo Dev` VS Code profile, and the `Include ~/.silo-dev/...` lines in `~/.ssh/config`.

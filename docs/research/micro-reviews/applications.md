# Applications micro-review

Scope: `app/SiloUI/src-tauri/src/applications/` (`launch.rs`, `linux.rs`, `macos.rs`). Read-only source review; no builds, test execution, or live application launches. Checked the initial, pass-2, and local pass-3 review reports; excluded the already reported Linux executable browser-selection defect.

## APPLICATIONS-1 · P2 · Flatpak editor launch drops installation identity

- **File:line:** `app/SiloUI/src-tauri/src/applications/launch.rs:67–76`; entry parsing at `applications/linux.rs:18–33`.
- **Trigger:** Select a supported Flatpak editor desktop entry whose `Exec` specifies a branch or architecture, for example `flatpak run --branch=beta --arch=aarch64 --command=code com.visualstudio.code %F`. The selected installation differs from the installation resolved by the bare application ID.
- **Evidence:** `entry_editor` supplies both parsed `Exec` arguments and `X-Flatpak`. When `X-Flatpak` is present, `linux_editor_command` ignores the entire `argv` and returns only `run <app id>`. This strips `--branch`, `--arch`, and `--command`. The existing Flatpak test asserts the stripped two-argument command. `editor.rs:194` then uses those returned arguments directly.
- **Consequence:** Opening a sandbox does not preserve the selected editor installation. It opens another branch/architecture when the bare ID resolves there, or fails when that resolution cannot find the selected installation. The exact entry path saved in Settings does not prevent this loss.
- **Suggested fix:** Preserve validated Flatpak installation and command selectors from the entry while removing field codes and file-forwarding markers; append Silo's workspace arguments after the selected application ID.
- **Test that would catch it:** Pass a supported editor entry with explicit branch, architecture, and command selectors through the resolver and editor launch builder. Assert that all selectors survive and the workspace follows the application ID. Cover two entries with the same `X-Flatpak` but different branches and require distinct launch commands.

## APPLICATIONS-2 · P2 · Ghostty launch ignores the selected bundle path

- **File:line:** `app/SiloUI/src-tauri/src/applications/macos.rs:682–685`, `macos.rs:709–712`, and `macos.rs:729–731`.
- **Trigger:** Two Ghostty bundles share `com.mitchellh.ghostty`, and the user selects the bundle whose path differs from the bundle resolved by Launch Services for that identifier.
- **Evidence:** `open_terminal` reads the selected bundle's identifier, then calls `ghostty_launch(command)` without its path. The script targets the constant `tell application id "com.mitchellh.ghostty"`. Neither the helper's arguments nor its script contain `application.path`. The Terminal/iTerm branch, by comparison, passes the selected path to `open -a` at line 700.
- **Consequence:** The terminal action targets the bundle resolved by identifier instead of the explicitly selected bundle. Selecting a newer Ghostty copy cannot reliably bypass an older registered copy that lacks the required scripting support, and the action can open the other copy.
- **Suggested fix:** Target the selected canonical Ghostty bundle path, passing it as script data alongside the command, and retain the bounded helper execution.
- **Test that would catch it:** Build launches for two Ghostty application paths with the same bundle ID and assert that their AppleScript target arguments differ and preserve each exact selected path. Add an opt-in macOS integration check with two bundle copies to verify the selected copy receives the command.

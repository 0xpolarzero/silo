# Editor follow-up: env working-directory operands

Scope: `app/SiloUI/src-tauri/src/applications/launch.rs`.

## EDITOR-5 · P2

- **Location:** `exec_program_index`.
- **Trigger:** An editor desktop entry runs `env -C /some/directory /usr/bin/code %F`, or uses the separate-operand `--chdir` form.
- **Evidence:** Integration's env-wrapper fix consumes the operand of unset options, but skips only the `-C` token and mistakes its following directory for the editor executable. `linux_editor_command` consequently rejects the selected supported editor. [GNU env documentation](https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html) specifies both the short and long working-directory options. The new behavior test failed against the merged production module with the directory returned instead of the executable.
- **Consequence:** A valid env-wrapped editor desktop entry cannot open VM folders through Silo.
- **Fix:** Consume the working-directory operand when locating the editor. Retain integration's wrapper execution so the selected working directory reaches the CLI.
- **Regression:** `env_working_directory_operands_do_not_replace_the_editor_program` covers both spellings and runs a temporary CLI through the short option, asserting its actual working directory and appended editor argument. It uses no editor GUI or live VM.

EDITOR-4's unset-operand and environment-preservation defect was independently fixed and folded by another agent in `1e966181` while this review was reproducing it. That implementation was adopted instead of creating a duplicate fix.

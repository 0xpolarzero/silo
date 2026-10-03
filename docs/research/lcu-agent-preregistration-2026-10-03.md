# LCU registration for harnesses installed later (research, 2026-10-03)

Scope: LCU v0.8.7 (`~/code/projects/msb-upstream/lcu`, tag v0.8.7). Paths below are relative to that repo unless noted. Silo today runs `lcu setup --agent auto --session direct --yes --approval <mode>` (`app/SiloUI/src-tauri/guest/silo-computer-use.py:374`).

## 1. What v0.8.7 does when a harness is absent

There is no flag or mode that registers an absent harness uniformly. Behavior differs per harness, and `--agent all` is only partly "pre-register".

| Harness | `--agent all` with harness absent | Evidence |
|---|---|---|
| Codex CLI | Registers. MCP entry is written by add-mcp straight into `~/.codex/config.toml` (no `codex` binary involved). Lifecycle hooks are installed through the ChatGPT app's bundled codex tools, not the user's CLI. The hook-support probe returns early if `codex` is not on PATH. | `lcu/codex_hooks.py:67-79` ("Registration also works before Codex CLI is installed"); `lcu/setup.py:277-289`, `:455`; `lcu/codex_hooks.py:110-170` |
| Claude Code | Registers. add-mcp writes `~/.claude.json` `mcpServers.lcu` directly. LCU then writes hooks and host-only-tool deny rules into `~/.claude/settings.json`. `--approval auto` adds `permissions.allow: ["mcp__lcu"]` there, and creates the file if missing. | `lcu/setup.py:277-289`; `lcu/claude_visibility.py`; `lcu/approval.py:132-175` |
| Pi | Fails, writes nothing. `shutil.which('pi')` is empty, so setup raises "Pi is not on the target account PATH" before writing any file. LCU's wrapper `extension.mjs` is also written only after that check. Registration itself is `pi install <extension>` (`PI_OFFLINE=1`), which needs the binary. | `lcu/setup.py:484-494`, `:497-514` |
| OMP | Fails, writes nothing. "Oh My Pi is not on the target account PATH". Registration runs `omp plugin link`. Approval runs `omp config set tools.approval`. | `lcu/harness_setup.py:60-62`; `lcu/approval.py:192-195`; test `tests/test_harness_setup.py:93-97` |
| Hermes | Fails, writes nothing. Registration runs `hermes plugins enable lcu-cua`. | `lcu/harness_setup.py:95-97` |

Consequences for `--agent all` in a bare VM:

- `configure()` continues past failures. Codex and Claude Code are fully registered, and Pi, OMP and Hermes are reported failed (`lcu/setup.py:419-427`, `:909-921`).
- `main` then raises "N registration step(s) failed ... retry: ...". The exit status is nonzero.
- `save_setup_state` runs only after full success (`lcu/setup.py:922`). The saved approval and opt-ins are therefore not persisted. Silo would see a `partial` outcome every time.
- The code comment at `lcu/setup.py:811` says "Select --agent explicitly (works before the agent is installed)". That is true only for `codex` and `claude-code`. `docs/INSTALLATION.md:151` says `--agent all` "reports missing harness prerequisites", which means the failure above.
- `--agent auto` (`detect`, `lcu/setup.py:711`) selects a harness if its binary is on PATH or its marker path exists (`.codex`, `.claude.json`, `.pi/agent`, `.omp`, `.hermes`, `lcu/setup_clients.py`). A leftover marker directory without the binary makes Pi, OMP or Hermes fail the same way.
- A saved `auto` approval is re-applied on later runs (`lcu/setup.py:850-856`).
- `release_root` is `<prefix>/current` (`lcu/setup.py:800`). Registered commands and wrapper import paths go through that symlink, so an LCU upgrade that flips `current` keeps existing registrations pointing at the new version. The OMP and Hermes generated files embed `release/...` paths that are not resolved.

## 2. What registration writes, and whether it survives a later harness install

| Harness | LCU registration writes | Honoured if present before install? |
|---|---|---|
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`): `[mcp_servers.lcu]` (add-mcp, plus host policy fields), `[hooks]` Stop/Interrupt/SubagentStop `mcp_tool` entries, and `hooks.state."<path>".trusted_hash`. `--approval auto` adds `default_tools_approval_mode = "approve"` (`lcu/approval.py:23-24,228-250`). | Very likely yes. The file is plain user config that the CLI only reads and edits, and add-mcp itself writes it without detection (`detectGlobalInstall` is only `existsSync(~/.codex)`). Risk: the hook trust hash is computed with the app-bundled codex. A different CLI version could compute another hash and mark the hooks untrusted until setup is rerun. Not tested. |
| Claude Code | `~/.claude.json` `mcpServers.lcu` (stdio, `node adapters/claude.mjs <lcu command>`). `~/.claude/settings.json`: hooks, deny rules, optional `permissions.allow`. | Likely yes. `~/.claude.json` is Claude Code's own mutable state file, which it merges and edits in place. Anthropic documents it as the user-scope MCP location. Not tested against a fresh `claude` install here. |
| Pi | LCU writes `~/.local/share/lcu/pi/extension.mjs` and `commands.json`. `pi install <extension.mjs>` adds a local-path entry to the `packages` array of `~/.pi/agent/settings.json` ([Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), [settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md): `packages` is an array of npm/git/local sources). | A hand-written `packages` entry would be read. Separately, Pi documents registry-free auto-discovery of `~/.pi/agent/extensions/*.ts` ([extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)). A file dropped there needs no registration command at all. |
| OMP | A generated package under `~/.local/share/lcu/omp/user-<hash>/` (`package.json` with `omp.extensions`, plus `index.ts` wrapper). `omp plugin link` creates a symlink `~/.omp/plugins/node_modules/<name>` and an `enabled: true` entry in `~/.omp/plugins/omp-plugins.lock.json`. Approval writes `tools.approval.js` / `.js_reset = allow` via `omp config`. ([plugin plumbing](https://github.com/can1357/oh-my-pi/blob/v18.4.1/docs/plugin-manager-installer-plumbing.md)) | The link plus lock entry is a CLI-owned registry. The docs state a link is not discovered without the symlink, and the first `omp plugin` run does not overwrite existing symlinks or lock entries. Hand-writing the lockfile means copying an internal schema (`{version, enabledFeatures, enabled}`). Not recommended. OMP auto-discovers `~/.omp/agent/extensions/` (and legacy `~/.pi/agent/extensions/`) ([extension-loading.md](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md), [authoring-extensions.md](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md)), so a drop-in extension is registry-free here too. |
| Hermes | `~/.hermes/plugins/lcu-cua/{plugin.yaml,__init__.py,lcu-config.json}`. `hermes plugins enable lcu-cua` adds the name to `plugins.enabled` in `~/.hermes/config.yaml`. Hermes may also run a capability-consent step for non-bundled plugins (`hermes_cli/plugins_cmd.py` `cmd_enable`). | The plugin directory is discovered before Hermes runs, but plugins are opt-in. Nothing loads until `plugins.enabled` lists it ([Hermes plugins docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)). Activation goes through Hermes's own transactional code, not a direct YAML edit. The installer copies `config.yaml` only when it does not exist (`scripts/install.sh:773-775`), so a pre-written file would survive, but Hermes then starts with a minimal config. Whether that interacts with its first-run setup is not tested. Pre-writing is possible but fragile. |

## 3. Existing multi-client MCP installers

LCU already depends on one: `scripts/agent-tools/package.json` pins `add-mcp` 2.4.0 and uses its library for Codex, Claude Code and Pi MCP-style writes (`lcu/setup.py:277-289`).

| Tool | License / activity | Clients | Writes without client installed | Env, approval |
|---|---|---|---|---|
| [add-mcp](https://github.com/neondatabase/add-mcp) (Neon) | Apache-2.0, 310 stars, v2.4.1 on 2026-09-29, pushed 2026-10-03 | 24, including Claude Code, Codex, Pi (writes `~/.pi/agent/mcp.json`, an MCP adapter file, not an extension). No OMP, no Hermes. | Yes with `-a <agent>` or `--all`; detection only picks defaults. | stdio `--env`; `supportedFields` has `autoApprove` for Claude Code and Codex, `timeout` for Pi. LCU still writes approval itself (`permissions.allow`, `default_tools_approval_mode`). |
| [install-mcp](https://github.com/supermemoryai/install-mcp) (Supermemory) | MIT, 195 stars, active | claude-desktop, cursor, vscode, claude-code, codex, gemini-cli, goose, zed, and others. No Pi, OMP or Hermes. | Writes the config for the named client. | Basic; no per-tool approval. |
| [Smithery CLI](https://github.com/smithery-ai/cli) | AGPL-3.0, last push 2026-05 | Registry-oriented; not a fit for local stdio plus policy. | n/a | AGPL is a poor fit for bundling. |
| [MCPM](https://mcpm.sh/) | Search result only | Claude Desktop, Claude Code, Codex CLI, Gemini CLI, others. Hermes was not seen in its list. | Not verified | Not verified |
| mcp-sync, My-MCP-Installer | Small projects | Config syncing for popular editors | Not evaluated | None of the above are known to cover Pi, OMP or Hermes |

None of them covers OMP or Hermes, and none of them registers LCU's Pi, OMP or Hermes adapters. Those are extensions or plugins, not plain MCP entries. They carry the lifecycle hooks and the approval prompts (`docs/ADAPTERS.md:78-105`). Adopting another tool adds no coverage over what LCU already has.

## 4. Recommendation

Option (b), implemented in LCU as two small additions, with an optional drop-in path as a later experiment. Do not adopt a new tool (section 3) and do not pre-write Hermes or OMP registry files by hand.

LCU already follows "prefer upstream installers" (`AGENTS.md`). Each harness's own CLI remains the only writer of its registry. The gap is only the timing, and that is fixed with a missing-harness skip plus a reconcile step.

### LCU changes

1. `lcu setup --agent all --allow-missing`. For each harness whose binary is absent, print `Pi: not installed; will register when it appears` and skip. Do not count it as a failure. Record the skipped set in `~/.local/state/lcu/setup.json` as `pending`. Exit 0 and persist chrome, audio and approval. Codex and Claude Code keep their current pre-install registration.
2. `lcu setup --reconcile [--quiet]`. Cheap and idempotent. If `pending` is empty, exit immediately. Otherwise look for each pending binary on PATH and in known install dirs (`~/.local/bin`, `~/.bun/bin`, `~/.hermes/...`). For those that appeared, run the same `configure()` with the saved chrome, audio and approval values (the saved-approval logic is `lcu/setup.py:850-856`). Remove each from `pending` on success.
3. Approval mode:
   - Claude Code and Codex are applied at registration time.
   - OMP's `tools.approval` needs the binary, so it is applied at reconcile time from the saved mode.
   - Pi and Hermes have nothing to configure (`lcu/approval.py:30-34`).
   - A later `lcu setup --agent all --allow-missing --approval ask|auto` re-applies the mode to registered harnesses and updates the saved mode, which `--reconcile` then uses for pending ones.
4. LCU upgrade: unchanged. Registrations point through `<prefix>/current`. Re-running `setup --agent all --allow-missing --yes` is only needed when the generated wrapper format changes. Reconcile can also compare the generated-file version and rewrite when it differs.

### Silo guest

- Replace `--agent auto` with `--agent all --allow-missing` in `silo-computer-use.py`. `classify_setup` should treat the `not installed; will register` line as neutral.
- Run `lcu setup --reconcile --quiet` on each boot and when the app becomes ready (Silo already runs `apply` at those points).
- Add a login hook, `/etc/profile.d/lcu-reconcile.sh`, that runs the reconcile only when `pending` is non-empty and a pending binary is on PATH. If the guest has systemd, a `.path` unit on `~/.pi ~/.omp ~/.hermes ~/.local/bin` would be a better trigger. I did not check the guest init.
- A harness installed by an agent from a non-login shell is picked up at the next boot, login shell or Silo `apply`. No registry-free alternative exists for Hermes, so there is a short window where it is not registered.

### Optional later step for Pi and OMP

Both document auto-discovery of drop-in extension files (`~/.pi/agent/extensions/`, `~/.omp/agent/extensions/`). LCU could write its existing wrapper file there at setup time, with no CLI and no trigger. This needs tests first:

- OMP also reads the legacy `~/.pi/agent/extensions/`. With both harnesses installed, the Pi wrapper could load in OMP, duplicating the `js` tool or lacking `ompEssentialTools`.
- It moves away from `pi install` and `omp plugin link` toward a harness-documented file location, which the "prefer upstream installers" rule only partly covers. Record the choice in `docs/`.

### Verification still owed

None of the following has been run:

- A real fresh install of Claude Code, Codex, Pi, OMP and Hermes over a pre-written config.
- Codex hook trust hash across CLI versions.
- `~/.claude.json` merge on first Claude launch.
- Hermes first run with a pre-existing `config.yaml`.

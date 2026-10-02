# Shell review, 2026-10-02

ShellCheck 0.11.0 and deterministic shell execution identified two masked
directory-creation failures. ShellCheck's [SC2155 guidance](https://github.com/koalaman/shellcheck/wiki/SC2155)
explains that `export name=$(command)` returns the export status, hiding the
command's failure from `set -e`. Assigning first preserves the failure status.

- `scripts/test-linux-gnome.sh`: a failed `mktemp` returned success and continued
  desktop setup. Assignment now precedes export, and XDG path exports are quoted.
  `test_linux_gnome_shell.py` executes the production script with fake desktop
  tools and checks failure propagation and paths containing spaces.
- `.github/workflows/apt-repository.yml`: a failed private GPG directory creation
  continued to key import. Assignment now precedes export, so failure stops the
  signing step before importing a key. `test_apt_release_shell.py` executes the
  actual workflow step with fake signing tools and synthetic key text, checking
  failure propagation and private-directory use through cleanup.

No desktop, VM, credential store, release publication, or real signing key was
used by these regressions.

The desktop recipe also masked a package-list read failure in
`for package in $(cat ...)`. The failed substitution produced an empty loop,
so the recipe accepted the preinstalled desktop without checking its packages.
The recipe now checks the read status before iterating. The guest fixture injects
one failed read and requires the full repair path, including every bundled
package, instead of accepting the image. A persistent read failure still stops
the later installation at its existing checked assignment.

The APT stale-publication gate compared two command substitutions directly.
When both `cat` and `gh api` failed without output, `test "" = ""` returned
success. Separate assignments now stop on either failure before comparing the
versions. The actual workflow-step regression covers both failures, individual
failures, equal versions, and a newer upstream version.

Audit coverage: ShellCheck checked 346 extracted units across all nine standalone
shell scripts (including extensionless Debian maintainer scripts), 134 workflow
steps, 109 Markdown shell blocks, Python/Rust literals, the generated image
verifier, and both Dockerfile RUN commands. Generated templates, npm commands,
and remaining shell call sites were also reviewed in their caller context.
The optional `check-extra-masked-returns` checks were included. Extraction output
and diagnostics are local evidence under `/tmp/silo-shellcheck-audit/`.

Remaining diagnostics do not establish defects: package and validated lock
records intentionally split into arguments; quoted heredocs and nested shell
commands intentionally defer expansion; sourced OS/debconf files are supplied
by the guest/package system; workflow shells already enable `errexit`; Rust
format placeholders are expanded before execution; and a macOS injection test
deliberately carries shell metacharacters as data. No blanket `pipefail` change
was applied to the POSIX guest scripts.

Verification: GNOME setup (2 tests), APT shell steps (4 tests), desktop recipe
(21 tests), and workflow pins (3 tests) passed with temporary files and fake
external tools. Focused ShellCheck, shell syntax, TypeScript typecheck, frontend
lint, Rust formatting, and whitespace checks passed for the fixes. Initial
desktop fixture failures exposed incomplete stdin handling in the new `cat`
test double; the corrected double passed the full recipe suite.

Final verification at `fe209cb3`: a fresh ShellCheck scan checked 343 automatically
extracted units after integration updates, with generated templates and Docker
commands reviewed separately. Every npm script also passed ShellCheck. The 21
desktop recipe tests and 2 GNOME setup tests passed again using `/bin/dash` for
their shell execution; all nine standalone scripts passed `dash -n`. A combined
run of GNOME setup, APT shell steps, workflow pins, and Linux verification tests
passed 18 tests. Typecheck and lint passed again on Node 24.11.1, replacing the
earlier host Node 26 checks. Final scan evidence is under
`/tmp/silo-shellcheck-final/`.

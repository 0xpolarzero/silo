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

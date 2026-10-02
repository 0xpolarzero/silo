# File permission fixes (2026-10-02)

All executions use temporary fixtures and synthetic keys. No app or VM was launched.

- `d1c99f37`: Dev import backups inherited old file modes. The new importer regression
  failed with `0666` instead of `0600`; all 13 importer tests pass after routing backups
  through the atomic writer. Typecheck, focused lint, and Rust formatting passed.
  The full release suite had 100 passes, 12 skips, and one unrelated runtime concurrency
  timeout; the isolated concurrency test also timed out. The saved logs are local build output.
- `c156b30c`: Reused editor/connection keys retained group and other permissions.
  The extracted production regression failed with `0666`, then passed with `0600`,
  unchanged private bytes, and the same OpenSSH public identity. Already private keys
  are left untouched. Typecheck, lint, and Rust formatting passed.
- Runtime home creation used default directory modes, and the private-directory helper
  only removed group/other write bits. With umask `000`, the isolated subprocess regression
  rejects the old creation path; the existing-parent regression rejects retained `0755`.
  The fix requests `0700` when creating directories and removes all group/other access
  on existing managed roots. The extracted tests pass 3/3, including symlink rejection
  without changing the symlink target. Contents are preserved during permission repair.

The extracted Rust checks use the production functions and tests with minimal collaborators
for channel path construction and process environment sanitation. Full Cargo regressions
were requested with synthetic GitHub configuration and the shared target directory; they
remain queued on its artifact lock at this checkpoint.

Primary API evidence is recorded in [build channels](../../SiloUI-BUILD-CHANNELS.md)
and [editor handoff](../../SiloUI-EDITOR-HANDOFF.md). Rust's
[directory builder](https://doc.rust-lang.org/std/os/unix/fs/trait.DirBuilderExt.html#tymethod.mode)
defaults to `0777`; explicit modes are necessary before private data is populated.

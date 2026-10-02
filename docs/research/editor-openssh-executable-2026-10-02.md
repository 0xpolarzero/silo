# EDITOR-8: OpenSSH preflight accepts non-executable files

P3: `require_openssh_at` checked only that the SSH and key-generator paths were files. Files without executable permission passed preflight and subsequently produced generic editor/desktop preparation failures instead of the existing OpenSSH installation guidance.

Reuse the application launcher's executable-file check. The existing temporary-file regression now checks missing files, two non-executable files, only SSH executable, and both executable. The non-executable assertion failed before the fix. Focused tests use extracted production editor functions and the complete production launch module, without invoking real SSH connections or reading user configuration. Red evidence: `/tmp/silo-codex-target/verification/editor/editor-8-before.log`.

---
"silo-ui": patch
---

Opening a sandbox in your code editor now works when `~/.ssh` or `~/.ssh/config` is a link managed by a dotfiles tool such as stow or chezmoi: Silo updates the linked file and keeps the link. When the linked file can't be changed, such as a home-manager file, the message shows the exact line to add yourself.

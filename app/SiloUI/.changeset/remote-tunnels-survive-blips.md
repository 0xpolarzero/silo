---
"silo-ui": patch
---

Ports and desktop viewers opened from another computer no longer close on a single failed refresh, such as a network blip or a busy computer; they close only after repeated failures or when that computer no longer accepts this one. Port connections that dropped (for example after sleep) or whose sandbox restarted reopen by themselves on the same local port, and saving a port again with Automatic keeps its previous local port. While a computer is unreachable, Silo stops opening a new SSH connection for its network status on every refresh.

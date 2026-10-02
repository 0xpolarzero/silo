---
"silo-ui": minor
---

New sandboxes come with a Linux desktop and agent computer use ready, with no setup. Silo downloads the official ChatGPT app for Linux from OpenAI by itself in the background on every computer that runs it (nothing to accept, retried automatically, never blocking sandbox creation or start) and shares it read-only with that computer's sandboxes; each sandbox installs LCU against it at boot, so Claude Code, Codex and other agents can use the desktop right away. Settings, Computers shows the download state on each computer and offers Retry after a failure. A per-sandbox switch lets computer-use actions run without asking first, and "Set up computer use" reruns setup after you install a new agent. Sandboxes created before this version keep their current desktop; create a new sandbox to use computer use.

---
"silo-ui": patch
---

Silo now reads your host Git author at most once a minute in the background instead of running Git on every refresh, so GitHub actions no longer wait for it. On a Mac without the developer tools, Silo no longer asks to install the Command Line Tools just to look up your Git author.

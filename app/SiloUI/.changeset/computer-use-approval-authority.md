---
"silo-ui": patch
---

Changing a sandbox's computer-use "Allow without asking" setting now returns at once and applies in the background: the panel shows "Applying…", and if it fails or only some agents change it says so and warns that some agents may still act without asking, and Silo tries again when the sandbox starts. Importing or transferring a sandbox starts from Silo's default, a failed command no longer shows an out-of-date setting, a stop or quit interrupts a running change, and a failed ChatGPT download no longer hides the confirmed setting. The switch configures the agents' approval prompts; it is not a security boundary inside the sandbox. Also: recovering an interrupted sandbox creation keeps its original settings, built-in desktops always start with their sandbox, and the desktop viewer no longer offers computer use setup after a failed ChatGPT download.

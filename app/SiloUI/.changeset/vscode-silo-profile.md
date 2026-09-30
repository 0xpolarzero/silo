---
"silo-ui": minor
---

Visual Studio Code now opens sandbox folders in a separate "Silo" profile, leaving your normal VS Code profile untouched. Those windows stop Git in the sandbox from using VS Code's GitHub sign-in and stop automatic port forwarding, so sandbox ports reach this computer only through Silo's published ports. The first time, VS Code asks to install Remote - SSH into the Silo profile.

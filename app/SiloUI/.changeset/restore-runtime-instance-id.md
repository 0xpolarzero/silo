---
"silo-ui": patch
---

Fix computer-use setup and storage reclaim after the MicroSandbox 0.7.6 update. The bundled runtime stopped reporting which run of a computer is active, so a built-in computer was never set up for computer use after it started and its disk space was not reclaimed after a start. The runtime reports it again, and Silo now says so plainly if a runtime ever lacks it.

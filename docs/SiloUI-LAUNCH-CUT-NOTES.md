# Silo launch cut: feature evidence

This film was created on 2026-09-27 from the product's current source and
documentation. The brief was a release video lasting no more than 60 seconds,
developed without reading `demo/` or previous film implementations. The result
is the independent [54-second launch cut](../artifacts/silo-launch-cut/README.md).

| Film claim | Primary product source | Scope preserved in the film |
| --- | --- | --- |
| Linux sandboxes on your computers | [README](../README.md) | Virtual machines, not containers; macOS and Linux hosts |
| Local and remote sandboxes in one app | [Connections model](../app/SiloUI/src/features/application/model/connections.ts) and README | Remote connection uses SSH; no claim that remote credentials are centrally managed |
| Familiar editors, terminals, local ports | [Overview](../app/SiloUI/src/features/application/pages/overview-page.tsx), [Network](../app/SiloUI/src/features/application/pages/network-page.tsx), README | Uses existing editor and terminal integrations and local port connections |
| An agent can use a Linux desktop | [Luda integration](SiloUI-LUDA.md) (since removed; LCU replaces it) | Optional desktop; supported agents must be installed and signed in by the user; example is labeled an illustration |
| Selected repositories, read-only by default | README and [GitHub access editor](../app/SiloUI/src/features/github/components/github-access-editor.tsx) | Shows OAuth policies; does not generalize this restriction to full-permission personal tokens |
| Credentials scoped by sandbox and HTTPS domain | [Secrets](SiloUI-SECRETS.md) | Does not claim secret values can never be disclosed, or that local signing keys are supported |
| Export local disks; restore as new sandboxes | README and the since-removed [Backup page](https://github.com/0xpolarzero/silo/blob/5ce177022e714329903cbf754f98dcce93c7e582/app/SiloUI/src/features/application/pages/backup-page.tsx) | No claim of remote backup management or rollback of a running machine |

The film uses Playwright for fixture capture, the installed `@napi-rs/canvas`
package for motion graphics, and FFmpeg for H.264/AAC mastering. These tools
operate only on local media and deterministic synthetic data. No runtime service,
protocol, account integration, or production dependency was added to Silo.

All music was synthesized for this cut from oscillators and seeded noise. The
visuals use Silo's existing mark geometry, product captures, and original vector
animation. Sources and outputs live in `artifacts/silo-launch-cut/`; large generated
media is ignored by Git.

Verification covers media rendering, composition, duration, stream format, frame
count, full-file decoding, and audio levels. It does not verify live VM health,
agent compatibility, an installed app, or release readiness.

Final verification passed: FFprobe counted 3,240 H.264 frames at 1920 × 1080,
60 fps, with an exact 54.000-second duration. The MP4 is 17,037,428 bytes and
contains stereo 48 kHz AAC plus an optional English caption track. FFmpeg decoded
the complete file without errors. The encoded soundtrack measured −16.0 LUFS
integrated loudness and −3.5 dBFS true peak. Nine storyboard frames, selected
full-resolution shots, and a contact sheet decoded from the final MP4 were
visually inspected. Results are saved in `output/verification.json` and
`output/audio-verification.txt` beside the master.

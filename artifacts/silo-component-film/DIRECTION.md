# One computer, within reach

36 seconds, 60 fps. Ivory, ink, Silo orange. The approved headline stays.
One project, `your-app`, lives on an office computer. A laptop starts it,
opens its code, connects its server, and gives an agent a desktop to test it.

The three eight-second treatments compare the same proof:

1. **The connection:** a laptop and a physical office computer establish place.
   The control travels to the owner; the resulting local address comes back.
2. **One workspace:** the actual sandbox row stays visible while terminal,
   network, and browser expand out of the selected action. Less explanation,
   more product fidelity.
3. **The address:** start inside a running terminal, isolate `3000`, reveal the
   real port row, and carry its loopback address into the browser bar. Strongest
   cause and effect, but needs the physical setup before it.

The final combines the connection's spatial clarity, one workspace's retained
identity, and the address's match cut. The studies are design comparisons,
not three competing completed films.

## Edit and motion

| Seconds | Proof | Transition |
| --- | --- | --- |
| 0–4 | Computers for your agents | Type masks reveal the headline, then move aside for the two computers. |
| 4–9 | Start it here. Run it there. | Two physical computers; click starts the remote VM; push into laptop. |
| 9–15 | Your terminal and editor access that VM | Real sandbox actions expand into a connected workspace. |
| 15–23 | Guest server becomes a laptop URL | Terminal port leads into real Network row; local URL becomes browser bar. |
| 23–30 | Agent uses the same app in its Linux desktop | Browser pulls back inside desktop, then a test produces a visible result. |
| 30–32 | Everything belongs to the same sandbox | Pull back from the desktop to its office owner before the brand close. |
| 32–36 | Silo. Computers for your agents. | Stable brand lockup and download URL with breathing room. |

Large type owns the opening and closing, not a permanent strip above the UI.
The primary object retains its position, scale or motion direction across a
transition. Easing accelerates briefly and settles cleanly. No UI bouncing.
Fast camera moves can blur; settled UI and copy remain sharp. Music uses a
120 BPM grid with sparse action accents and space under the product proof.

## Source and constraints

Actual imports: SiloMark, SandboxListRow, SandboxAction, ComputerBadge,
WorkspaceStatus, NetworkPage, production tokens and CSS. The terminal,
editor, fictional web app, and Linux desktop display are illustrative
contents, not a native VM recording. All product state is fixed by the frame.
No native actions, user credentials, or live VM data.

The computers are already connected. Silo stays running on the owner. The
development server listens on 0.0.0.0:3000. The example forwarded address is
127.0.0.1:51432 on the laptop, not a public URL. The optional desktop and agent
are already installed and configured in the guest.

## References

- [Leon Lin implementation](https://github.com/Leonxlnx/claude-launchvideo):
  product objects carrying the story through continuous transforms.
- [Mia explanation](https://x.com/MiaAI_lab/status/2103837521645867073):
  visual and musical timing designed together.
- [no-slop-motion](https://github.com/ferndesk/no-slop-motion/blob/main/skills/no-slop-motion/SKILL.md):
  style frame and animatic separation; simplify elements without losing energy.
- [Remotion](https://www.remotion.dev/docs/the-fundamentals): frame-driven React.

The preceding directed film is archived in commit `28f52eb`. No `demo/`,
existing website film, or parallel launch-cut implementation was inspected.

# Desktop selection: primary-source evidence, 2026-09-22

Research conclusion: **the evidence does not establish Xfce as a unique desktop winner.** Xfce, MATE, and a specified LXQt/window-manager combination are credible CPU-first candidates; Plasma is a credible competitor with stronger documented desktop programming interfaces and design guidance. GNOME has strong design/accessibility infrastructure and the longest ordinary Ubuntu 24.04 desktop support route. None has won a comparable Silo performance, reliability, or human usability test.

This is a desktop evidence annex, not a streaming recommendation. It assumes an Ubuntu 24.04 guest on amd64 and arm64, a shared human/agent desktop, and a baseline without a demonstrated GPU. Existing implementation and migration cost earn no points. No particular agent library's present support is used as a constraint.

## Evidence notation and scoring discipline

- **D**: documented capability in a primary source; this proves availability, not performance or correctness in Silo.
- **M**: first-hand measurement with stated environment. Transfer only to sufficiently comparable environments.
- **U**: unverified. Do not silently convert U to a failing score or an average score.
- **P**: product policy or inference. State it separately from facts.

For a numerical capability score, each named requirement earns 1 only after matching D evidence to the exact selected version; an explicit incompatibility earns 0; U stays unknown. Report `confirmed points / total requirements`, plus unresolved requirements. Do not normalize away unknowns. RAM, CPU, latency, crash frequency, and first-use intuitiveness remain separate measured axes, not bonus points for a project's reputation.

Project-level evidence and packaged-version evidence must remain separate. A current project can have an old or minimally maintained package line. A recent commit is not evidence that a vulnerable or broken stable build has been repaired and distributed.

## What Ubuntu 24.04 actually supplies

The package versions below identify the Ubuntu Noble line, not an exhaustive frozen install manifest. `noble-updates`, security updates, and dependencies must be resolved into a manifest before any test. Metapackage installed size is not desktop footprint.

| Candidate | Noble package evidence | Upstream direction and its relevance |
| --- | --- | --- |
| Xfce | [`xfce4` 4.18](https://packages.ubuntu.com/noble/xfce4); its listed core includes Thunar, panel, session, settings, xfconf, desktop, xfwm4 | [Stable desktop release remains 4.20](https://xfce.org/download). [4.20's Wayland session is explicitly experimental](https://xfce.org/about/tour), with incomplete functionality; this must not be treated as a qualified Wayland replacement. |
| LXQt | [`lxqt-session` 1.4.0](https://packages.ubuntu.com/noble/lxqt-session), Qt 5 dependencies, amd64 and arm64 binaries | [2.4.0 released 2026-04-20](https://lxqt-project.org/release/2026/04/20/release-lxqt-2-4-0/). Do not attribute 2.x Wayland capabilities to Noble's 1.4 session. |
| MATE | [`mate-desktop` 1.26.2](https://packages.ubuntu.com/noble/mate-desktop), amd64 and arm64; [core metapackage](https://packages.ubuntu.com/noble/mate-desktop-environment-core) | [1.28 release](https://mate-desktop.org/blog/2024-02-27-mate-1-28-released/) dates to 2024-02-27 and describes experimental Wayfire-based MATE-Wayland. The project has [component activity in August 2026](https://github.com/mate-desktop); the old headline release alone does not establish abandonment. |
| Cinnamon | [Noble package index](https://packages.ubuntu.com/search?keywords=cinnamon&searchon=names&suite=noble): Cinnamon 6.0.4, amd64 and arm64; core/full metapackage numbering differs | The [Mint-maintained Wayland status notice](https://forums.linuxmint.com/viewtopic.php?p=2528716) updated 2026-04-03 identifies Cinnamon 6.6 in Mint 22.3 and still calls its Wayland support alpha. Do not claim that is the latest upstream version solely from this notice. |
| GNOME | [`gnome-shell` 46 line](https://packages.ubuntu.com/noble/gnome-shell), amd64 and arm64; [Ubuntu 24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/) | [GNOME's release calendar](https://release.gnome.org/calendar/) lists 50 in March 2026 and 51 scheduled for September 2026. [The GNOME 50 development announcement](https://discourse.gnome.org/t/232-upcoming-deadlines/33629) records native X11 removal from Shell. That does not remove Xwayland application compatibility. |
| KDE Plasma | [`plasma-desktop` 5.27.11](https://packages.ubuntu.com/noble/plasma-desktop), amd64 and arm64; recommends KWin X11 or Wayland | [Plasma 5 schedule](https://community.kde.org/Schedules/Plasma_5): no further planned releases; urgent/security fixes can trigger one. [Plasma 6.8 will be Wayland-exclusive](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/). Noble's 5.27 must not receive points for Plasma 6 features. |
| i3 / Sway | [`i3-wm` 4.23](https://packages.ubuntu.com/noble/i3-wm), amd64 and arm64 | [i3](https://i3wm.org/) is an X11 tiling window manager. [Sway](https://github.com/swaywm/sway/releases) is separately maintained; 1.12 release lists 138 changes from 50 contributors. Neither alone supplies the complete desktop being compared above. |

Xfce's metapackage is architecture-independent; verify its compiled dependency closure on both architectures. Package presence is a packaging qualification, not a test that the complete session starts correctly in a headless guest.

## The lifecycle constraint is already close

As of this assessment, fewer than eight months remain until April 2027. The published Ubuntu 24.04 flavor support endpoint is April 2027 for [Xubuntu](https://xubuntu.org/releasedocs/24.04/release-notes/), [Lubuntu](https://lubuntu.me/noble-released/), [Kubuntu](https://www.kubuntu.org/download/), and [Ubuntu MATE](https://ubuntu-mate.org/download/). These are flavor commitments; they do not promise that every package combination Silo assembles is supported. Conversely, a flavor endpoint does not mean every package becomes unmaintained that day.

Do not transfer the Ubuntu base's longer support period to every Universe desktop component. Track security coverage of the exact packages and any applicable Ubuntu Pro entitlement separately. GNOME's position in standard Ubuntu Desktop is materially different from choosing a Universe flavor stack; this is a support consideration, not a UX popularity contest.

Kubuntu's next base also changes the decision: [Kubuntu 26.04 ships Plasma 6.6 and supports Wayland](https://kubuntu.org/news/kubuntu-26-04-release-notes/); its X11 package is available but explicitly unsupported by the Kubuntu team. [Kubuntu's September 2026 support announcement](https://kubuntu.org/news/kubuntu-26-04-1-bullet-proof-kde/) reports funded maintenance for the Plasma 6.6/Frameworks/Gear stack. Therefore a long-term Plasma choice should qualify a current Wayland stack, not assume indefinite maintenance of the Noble X11 arrangement.

## Observable capabilities rather than impressions

| Criterion | What the evidence supports | What it does not support |
| --- | --- | --- |
| Full desktop | Xfce, LXQt, MATE, Cinnamon, GNOME, and Plasma provide desktop components. i3/Sway require an explicitly assembled application/menu/settings/session offer before comparison. | A bare WM is not a fair footprint comparison against a desktop containing file management, policy prompts, clipboard service, accessibility, and settings. |
| Optional compositing | Xfce exposes compositor settings; MATE has a boolean `compositing-manager` setting; LXQt allows a selected WM with a separate optional compositor. Plasma X11 has a separate compositor, and KDE documents behavior with it disabled. | Optional compositing does not by itself prove lower total CPU, memory, or streamed latency. GNOME/Cinnamon software rendering must not be called impossible merely because their shells integrate compositing. |
| Desktop configuration | Xfce has a documented `xfconf-query` read/write/monitor CLI. MATE exposes GSettings. LXQt documents session configuration and selected WM configuration. Plasma documents KConfig and scripting. | Readable config files are not automatically a complete, live, typed configuration API. |
| Window control | Xfce explicitly documents `wmctrl` and libwnck. Marco documents EWMH/ICCCM support. KWin has a documented scripting API and change signals. i3/Sway document JSON IPC with commands, state queries, and event subscriptions. | An API existing does not prove input race freedom, stable semantic identifiers, complete application accessibility, or agent task success. |
| Design process | GNOME and KDE publish substantial human interface guidelines. All candidates have user documentation, though depth and version coverage vary. | Guidelines do not establish that a new Silo user completes tasks faster. Distribution adoption is not a user study. |
| Accessibility / semantic UI | GTK implements AT-SPI for standard widgets; Qt exposes accessible objects, roles, states, actions, and events. This supports semantic automation across multiple desktops. | Choosing GTK or Qt does not make every application or custom canvas accessible. Actual application coverage must be tested. |

Capability sources: [Xfwm settings](https://docs.xfce.org/xfce/xfwm4/4.18/wmtweaks), [Xfce window-control FAQ](https://docs.xfce.org/xfce/xfwm4/faq), [xfconf-query](https://docs.xfce.org/xfce/xfconf/xfconf-query), [Marco 1.26.2 settings schema](https://github.com/mate-desktop/marco/blob/v1.26.2/src/org.mate.marco.gschema.xml), [Marco architecture and EWMH](https://github.com/mate-desktop/marco), [LXQt window managers](https://lxqt-project.org/wiki/Window-managers-%28X11%29.html), [KDE X11 issue inventory](https://community.kde.org/Plasma/X11_Known_Significant_Issues), [KWin scripting](https://develop.kde.org/docs/plasma/kwin/), [KWin API](https://develop.kde.org/docs/plasma/kwin/api/), [i3 IPC](https://i3wm.org/docs/ipc.html), [Sway IPC](https://github.com/swaywm/sway/blob/master/sway/sway-ipc.7.scd), [GNOME HIG](https://developer.gnome.org/hig/), [KDE HIG](https://develop.kde.org/hig/), [GTK AT-SPI](https://developer.gnome.org/documentation/guidelines/accessibility.html), [Qt accessible interfaces](https://doc.qt.io/qt-6/qaccessibleinterface.html).

LXQt is not a fully specified candidate until the WM is named. Its documentation says it supplies no WM, and records integration caveats for KWin and Xfwm4. Scoring LXQt's resource use with Openbox but awarding KWin's scripting capabilities would combine incompatible evidence. Test LXQt+Openbox and LXQt+Xfwm4 as separate builds if both are interesting.

Plasma is not disqualified by lack of a physical GPU: [Qt 5.15 documents a software scene-graph backend](https://doc.qt.io/archives/qt-5.15/qtquick-visualcanvas-adaptations.html), including its limitations and diagnostic controls. This is a documented software-rendering mechanism, **not** proof that Silo's Plasma session performs acceptably. Likewise, a compositor-free Xfce session still runs applications that can independently require software GL rendering.

## Maintenance and battle testing

Positive evidence includes shipped distribution packages, release artifacts, public issue processes, identified maintainers, and stable security fixes. No candidate receives points for GitHub stars, endorsements, being unpopular, or having few issues. Issue counts without installed-user exposure and triage policy are not comparable failure rates.

- Xfce has [named core and documentation maintainers](https://www.xfce.org/about/credits), [xfdesktop 4.20.2 in March 2026](https://archive.xfce.org/src/xfce/xfdesktop/4.20/), and [xfce4-session 4.20.4 in March 2026](https://archive.xfce.org/src/xfce/xfce4-session/4.20/). Those current-line artifacts do not prove equivalent fixes reached Noble 4.18.
- LXQt has a [public component release history](https://lxqt-project.org/releases/) through August 2026, including releases and patch releases. The project [documents component-specific issue reporting](https://lxqt-project.org/wiki/Reporting-bugs.html).
- MATE has a [named development and distribution packaging team](https://mate-desktop.org/team/) and recent component activity. A 2024 desktop-wide release date warrants checking stable patch delivery, not declaring the project abandoned.
- GNOME and KDE have documented nonprofit governance, elected boards, and published project infrastructure responsibilities: [GNOME Foundation](https://foundation.gnome.org/), [KDE e.V.](https://ev.kde.org/). These are evidence of organizational continuity; they are not measured mean time to repair a Silo regression.
- Cinnamon is developed within the Linux Mint ecosystem. [Mint's supported editions](https://linuxmint-installation-guide.readthedocs.io/en/latest/choose.html) document Cinnamon, MATE, and Xfce offerings. Mint's support commitment must not be transferred to Silo's Ubuntu Cinnamon packages.

The library checklist's arbitrary age ceiling, rewrite requirement, and “most popular” dealbreaker should not become desktop gates. They reject mature platforms without testing the actual risks. Replace them with patch availability, maintainers able to review changes, reproducible builds, documented interfaces, a credible supported upgrade route, dependency closure, and measured failures.

## What performance measurements actually establish

Two first-hand measurements were located; neither qualifies as Silo performance evidence:

| Measurement | Observation | Transfer limit |
| --- | --- | --- |
| [Fedora Magazine, 2019-12-04](https://fedoramagazine.org/fedora-desktops-memory-footprints/) | Author installed Fedora 31 desktop defaults in separate KVM VMs, 1 CPU/4 GB RAM, then sampled after five minutes. Reported memory: LXQt 391 MB, Xfce 448, MATE 465, GNOME 612, Cinnamon 624, Plasma 733. | Old releases; distro-specific background services and desktop terminals; no streaming or task latency; not a common minimal package manifest. These numbers are historical observations, not current estimates. |
| [Phoronix first-hand benchmark, 2025-04-02](https://www.phoronix.com/review/ubuntu-2504-x11-gaming) | Same Ubuntu 25.04/kernel/Mesa on Ryzen 9900X3D and Radeon RX7900XTX compared GNOME 48, Plasma 6.3, Xfce 4.20, and LXQt 2.1 sessions. GNOME/Plasma Wayland performed better in the tested gaming workloads. | GPU rendering, games, different release and architecture target, and changed display protocol. It refutes “lightweight always means faster”; it does not rank CPU-only desktop streaming. |

No comparable modern primary measurement was found for all candidates under Silo's guest, CPU-only rendering, identical application set, and WebKit receiver. That is an explicit evidence gap, not a reason to award a performance score from memory-use folklore.

## Decision that these facts support

The defensible leaderboard is currently **axis-specific**:

1. **Documented general-desktop programming and UX design infrastructure:** Plasma is a leading candidate because it combines a full desktop, public HIG, and explicit window-management scripting APIs. GNOME is also strong on HIG and accessibility infrastructure. This is documentation/capability ranking, not measured intuitiveness or agent success.
2. **Compositor-optional full-desktop candidates for a CPU-only Noble guest:** Xfce, MATE, LXQt with a specified WM, and Plasma X11 qualify for comparison. The evidence does not order their performance. Calling Xfce uniquely optimal would add an unsupported assumption.
3. **Small, explicit WM control protocol:** i3/Sway lead on the directly documented JSON IPC surface, but are incomplete offers for the required shared general-purpose desktop until accompanying UX components are specified.
4. **Shipped support runway:** GNOME through standard Ubuntu Desktop differs from the April 2027 flavor commitments. For Plasma, a new long-lived decision should evaluate the supported current Wayland route, not rely on 5.27's residual upstream maintenance.

**Policy recommendation:** keep Xfce, LXQt+Openbox, MATE, and Plasma in the technical shortlist; compare GNOME when support runway and accessibility carry substantial weight. Do not spend effort qualifying every visual theme or minimalist WM before these candidates are measured. A unique desktop winner is not established by this annex. Choosing Xfce today can be an explicit policy preference for a conventional modular X11 desktop, but it is not a factual victory over MATE/LXQt/Plasma.

The next action is one controlled comparison, using the same guest base, fixed per-architecture package manifests, identical applications, resolution and streaming stack, repeated cold starts and steady-state trials. Record guest PSS plus host VM memory, CPU time, image dependency size, task completion latency, and session/input failures. Run a fixed human task script and an independent semantic/window/input agent script, and publish all failures as well as successes. Predeclare the acceptable resource budget and the minimum improvement required to select a winner; otherwise the scoring weights can be moved after the result to favor any desktop.

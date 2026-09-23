# Codex, E2B and Luda computer use, 2026-09-22

**Follow-up finding:** the official Linux ARM64 desktop package ships the native
engine, and a direct API smoke test passed in a disposable Ubuntu 24.04 X11
desktop. Product documentation still says the Linux Computer Use feature is
unavailable. See [the distribution and live probe](codex-linux-engine-probe-2026-09-22.md)
before treating the missing binary in the Mac installation as a Linux blocker.

## Finding

The native computer-use interface available in this Codex session is hybrid:
accessibility state and element actions, with screenshots and coordinate input
as fallbacks. That places its exposed design closer to Luda than to E2B's
stock Desktop helpers. It does not establish comparable implementation quality
or task success. The useful hypothesis is that a smaller agent-facing contract
improves results, not that Codex's Mac experience proves pixels alone are better.

The initial comparison was documentation and source research, without comparative
agent runs or GUI mutations. The subsequent engine probe above used a synthetic
GTK window in an isolated container. The user reports excellent Mac computer-use results;
the model, applications and task distribution behind that experience were not
recorded for a controlled comparison.

## Evidence and provenance

### Codex's native interface: directly available session documentation

The installed `mcp__cua_repl.js` tool returned its runtime API documentation on
the initial read-only `cua.getState()` invocation. These are observed interface
capabilities, not claims inferred from macOS permission names:

- `getAXState()` provides accessibility state; `getScreenshot()` provides
  pixels; a combined observation is also available.
- `click` accepts an element index or coordinates. The same target abstraction
  supports scrolling, text selection, setting a value, and invoking an exposed
  secondary accessibility action.
- Native app operations include typing, paste and keypresses. App bindings
  keep the target implicit rather than requiring it in every operation.
- The documented workflow uses fresh accessibility state after actions and
  re-derives element indices. It prefers element targets when available and
  falls back to screenshots and coordinates when needed.
- A persistent JavaScript session allows several deterministic operations and
  their next observation in one tool call. Accessibility observations can be
  returned as changes rather than a repeated full tree on macOS.

The interface presents ordinary action methods and observations rather than
Luda's explicit snapshot tickets and effect receipts. That is a difference in
the exposed contract; it does not prove the absence of internal validation,
retries, event handling or other complexity. We did not inspect proprietary
backend implementation or establish which routes previous user tasks took.
The inventory returned alongside documentation is not retained in this report.

Public [product documentation](https://learn.chatgpt.com/docs/computer-use)
confirms native application control and macOS screen/accessibility permissions.
The [usage guide](https://learn.chatgpt.com/use-cases/use-your-computer-with-codex)
documents background Mac operation while the user works in other apps. Those
pages do not specify the element-action dispatch algorithm. Their permission
requirements alone would not establish accessibility-tree use; the live API
documentation supplies that evidence.

### OpenAI's public API is a separate integration surface

The [computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
documents code execution and a structured mouse/keyboard `computer` tool. The
current guide recommends code execution for GPT-6 Astra, with persistent state
and grouped operations. Existing function/MCP interfaces are also supported.
The [integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
include an Xfce/Xvfb desktop and `xdotool` actions. This is strong prior art for
a small Linux control implementation. It is not documentation of the Mac
product's internal architecture or a benchmark ranking the alternatives.

### E2B and the pinned Luda integration

The [E2B Desktop implementation](https://github.com/e2b-dev/E2B/blob/main/packages/desktop-js/src/sandbox.ts)
uses `scrot` screenshots and `xdotool` input, plus window/app helpers and VNC
streaming. Its inspected desktop methods do not expose accessibility-tree
targeting. The model and surrounding agent loop remain separate from those
helpers. See the [E2B fit assessment](e2b-fit-2026-09-22.md) for infrastructure.

Silo pins Luda 0.3.4, commit
`e3863fb24dd28bda5910a8c2382a13afd4ee1064`. Its
[tool contract](https://github.com/0xpolarzero/luda/blob/v0.3.4/docs/TOOLS.md)
provides accessibility inspection/actions, screenshot input, bounded target
identities, and scoped verification results. Silo's
[integration](../SiloUI-LUDA.md) installs 36 MCP tools and agent guidance;
the optional browser provider and Editor Bridge are absent.

| Aspect | Codex native interface observed here | E2B Desktop helpers | Silo's Luda |
| --- | --- | --- | --- |
| Observation | Accessibility state and screenshots | Screenshots, window information | Accessibility inspection and screenshots |
| Input targeting | Element index or coordinates | Coordinates and keyboard | Element/window IDs or screenshot coordinates |
| Agent-facing execution | Persistent JS, action groups and observation | Python/TypeScript library; caller supplies agent loop | Individual MCP operations and skill |
| Verification boundary | Observe resulting UI; backend internals unknown | Caller supplies outcome checks | Some operations verify scoped state; agent still checks task completion |

## Evidence for the simplicity hypothesis

The [Luda 0.3.3 diagnosis](../SiloUI-LUDA-033-DIAGNOSIS.md) identifies a real
semantic mismatch: accessibility selection highlights an Xfce theme row;
activation applies it. A physical single click can do both. Agents repeatedly
stopped after selection and falsely reported completion despite scoped tool
warnings. A corrective semantic activation succeeded. Thus accessibility was
capable of finishing the task, while choosing the wrong semantic operation
created an avoidable failure path.

Renaming the success label did not fix the recorded reproduction. Requiring
another screenshot also failed when the agent interpreted unchanged desktop
decoration as changed application appearance. These observations do not isolate
tool count, prompt length, model quality or visual grounding as the cause.

The [accepted skill experiment](../SiloUI-LUDA-SKILL-BENCHMARK.md) subsequently
passed two unchanged development batches and two live theme tasks; that exact
skill ships in 0.3.4. The skill grew from 826 to 1,999 words. This is a reason to
measure the cost of the added guidance, not proof that its length hurts results.
The tasks informed development and do not establish unseen-task reliability.

## Decision and falsifiable next experiment

Do not infer E2B task superiority from its smaller implementation, or Luda task
superiority from its richer feature list. Codex's working hybrid interface
undercuts the claim that accessibility itself must be removed; it supports
examining how much backend detail the agent has to manage.

Before expanding Luda further, compare three controls against the same existing
Linux desktop: screenshot/input only; current Luda; and a compact hybrid
interface with accessibility targeting and visual fallback. The first can run
on Silo's current sandbox without adopting E2B's full runtime. If it reproduces
E2B's control pattern without using its SDK, label it an E2B-style baseline,
not an E2B product benchmark.

Hold the model/version, reasoning settings, applications, display, starting
states, time budget and available non-GUI tools constant. Record prompt/tool
context as a measured difference. Separate model/OS comparisons from tool
comparisons: Mac success versus Linux failure changes multiple variables.

Freeze unseen tasks and independent success checks before tuning. Include
form editing, Unicode text, file selection versus opening, theme application,
save/export completion, missing accessibility, and human takeover. Repeat
from reset states in randomized order. Count independently verified completion,
false completion, retries, time and token use; report uncertainty rather than
turning a small pilot into a universal success rate.

The smaller interface earns adoption if it preserves acceptable verified
completion and false-completion rates while reducing time, tokens or maintenance
cost. Set acceptable differences before running the comparison. No such result
has been measured yet.

## Installed artifacts located for the implementation handoff

Product availability is separate from the artifacts below. The current
[Linux desktop guide](https://learn.chatgpt.com/docs/linux/linux-app#compatibility-and-limitations)
explicitly says Computer Use is available on macOS and Windows, not yet in the
Linux preview, with Linux support planned for a future release. The bundled
Linux adapter and API documentation do not establish a supported installable
Linux computer-use product today.

Read-only inspection found more concrete reference material locally:

- Plugin root:
  `/Users/polarzero/.codex/plugins/cache/openai-bundled/computer-use/1.0.1001103/`.
  `.codex-plugin/computer-use-node-repl.md` contains installed skill-style
  instructions and the lower-level `@oai/sky` interface. Compare it with the
  current live unified `cua` contract rather than assuming they are identical.
  `.codex-plugin/plugin.json` explicitly declares `license: Proprietary`.
- Runtime packages:
  `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/`.
  `cua` 0.2.5, `sky` 0.7.1 and `cua-repl` 0.1.0 include readable JavaScript,
  declarations and documentation. Their inspected package metadata has no
  license field; `private: false` does not establish redistribution permission.
- `sky/dist/project/cua/sky_js/src/targets/linux/sky_linux.js` dispatches through
  `SkyLinuxTransport` to a separate `bin/linux/sky_linux_<architecture>` server,
  with an `OAI_SKY_LINUX_BIN` override. The inspected `sky/bin/` directory is
  empty. This establishes a Linux adapter, not an available complete Linux
  engine or its source in that Mac installation. The subsequent Linux package
  inspection found and tested the engine; see the follow-up linked above.
- The installed Mac plugin launcher delegates to
  `~/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`.
  That client and the app's `Resources/native/sky.node` are compiled Mach-O
  ARM64 components. They are not Linux executables or readable native source.

The [official open-source inventory](https://learn.chatgpt.com/docs/open-source)
lists Codex CLI, SDK and app-server among available components. It does not
establish an open-source license for these installed computer-use packages.
Direct reuse should be evaluated component by component, separately from
independently implementing equivalent behavior. No implementation files were
copied into this repository and no permission to redistribute these components
was established by this inspection.

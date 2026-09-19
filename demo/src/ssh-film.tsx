import { useLayoutEffect, useRef } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  useCurrentFrame,
} from "remotion";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  FileKey2,
  Folder,
  GitBranch,
  Globe,
  Laptop,
  Monitor,
  Box,
  Loader2,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Terminal,
} from "lucide-react";
import { Product } from "./product";
import { typed } from "./timeline";
import {
  sshTiming as t,
  siloCursor,
  agentCursor,
  cursorAt,
  sshCamera,
  type CursorStop,
} from "./ssh-timeline";

// All connections, native dialogs and agent actions are inert illustrations.
function SiloSsh({ frame }: { frame: number }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const handle = delayRender("Prepare SSH controls and menu");
    let cancelled = false;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    // Exercise production copy feedback without touching the host clipboard.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    const settle = async () => {
      const tick = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (frame >= t.expand)
        root.current
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="SSH controls for demo"]',
          )
          ?.click();
      await tick();
      if (cancelled) return;
      if (frame >= t.copy && frame < t.menu)
        root.current
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="Copy network SSH address"]',
          )
          ?.click();
      if (frame >= t.menu && frame < t.saveDialog) {
        root.current
          ?.querySelector<HTMLButtonElement>(
            '[aria-label="More network SSH actions"]',
          )
          ?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
      }
      await tick();
      if (cancelled) return;
      if (frame >= t.saveDialog - 5 && frame < t.saveDialog)
        document
          .querySelector<HTMLElement>(
            '[aria-label="Save network SSH key file"]',
          )
          ?.focus();
      await tick();
      if (!cancelled) continueRender(handle);
    };
    void settle();
    return () => {
      cancelled = true;
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      continueRender(handle);
    };
  }, [frame]);
  return (
    <div ref={root} className="ssh-silo">
      <Product page="ssh" frame={frame} />
    </div>
  );
}
function TrafficLights() {
  return (
    <div className="ssh-lights">
      <i />
      <i />
      <i />
    </div>
  );
}
function Pointer({
  frame,
  points,
}: {
  frame: number;
  points: readonly CursorStop[];
}) {
  const cursor = cursorAt(frame, points);
  return (
    <svg
      className="ssh-pointer"
      style={{
        left: cursor.x,
        top: cursor.y,
        transform: `scale(${cursor.pressed ? 0.88 : 1})`,
        transformOrigin: "3px 2px",
      }}
      width="27"
      height="34"
      viewBox="0 0 28 35"
    >
      <path
        d="M3 2v26l7-7 6 11 5-3-6-10h10L3 2Z"
        fill="white"
        stroke="#292929"
        strokeWidth="1.7"
      />
    </svg>
  );
}

// The app camera pulls back into this laptop and stays there through execution.
function TwoComputers({ frame, zoom }: { frame: number; zoom: number }) {
  const camera = sshCamera(frame);
  const hardwareScale = camera.scale / 0.57;
  const connected = frame >= t.connected;
  const working = frame >= t.submit;
  const reveal = Math.max(0, Math.min(1, (zoom - 0.25) / 0.6));
  return (
    <div
      className={`ssh-devices ${connected ? "linked" : ""}`}
      style={{ opacity: reveal }}
    >
      <div className="ssh-machine-name laptop-name">
        <Laptop size={27} />
        <strong>My laptop</strong>
        <span>Agent app</span>
      </div>
      <div className="ssh-machine-name desktop-name">
        <Monitor size={27} />
        <strong>Office Mac</strong>
      </div>
      <div
        className="ssh-hardware-camera"
        style={{
          transform: `translate(${camera.x - 13 * hardwareScale}px, ${camera.y - 238.6 * hardwareScale}px) scale(${hardwareScale})`,
        }}
      >
        <div className="ssh-laptop-hardware">
          <div className="ssh-laptop-camera" />
          <div className="ssh-laptop-display" />
          <div className="ssh-laptop-base">
            <i />
          </div>
        </div>
      </div>
      <div className="ssh-device-link">
        <span>{connected ? "SSH" : "Connecting…"}</span>
        <div
          style={{
            transform: `scaleX(${Math.max(0, Math.min(1, (frame - t.connect - 24) / 36))})`,
            transformOrigin: "left",
          }}
        />
        {connected && <small>192.168.1.42:2222</small>}
      </div>
      <div className="ssh-desktop-hardware">
        <div className="ssh-desktop-display">
          <header>
            <TrafficLights />
            <strong>Silo</strong>
          </header>
          <div className="ssh-host-content">
            <div className="ssh-host-heading">
              Sandboxes<span>1 running</span>
            </div>
            <div className={`ssh-physical-vm ${working ? "working" : ""}`}>
              <div className="ssh-physical-vm-heading">
                <Box size={29} />
                <strong>demo</strong>
                <span>VM</span>
                <i /> Running
              </div>
              <div className="ssh-remote-repo">
                <Folder size={25} />
                <div>
                  <strong>hello-silo</strong>
                  <span>/workspace/hello-silo</span>
                </div>
              </div>
              <div className="ssh-vm-session">
                <Terminal size={22} />
                <span>
                  {working
                    ? "Agent working here"
                    : connected
                      ? "SSH session connected"
                      : "Waiting for connection"}
                </span>
              </div>
              {working && (
                <div className="ssh-live-execution">
                  <div>
                    <span>$</span> {typed("pwd", frame, t.submit + 12, 2)}
                  </div>
                  {frame >= t.submit + 23 && <p>/workspace/hello-silo</p>}
                  {frame >= t.submit + 36 && (
                    <div>
                      <span>$</span> {typed("ls", frame, t.submit + 36, 2)}
                    </div>
                  )}
                  {frame >= t.submit + 45 && (
                    <p>package.json &nbsp; src/ &nbsp; README.md</p>
                  )}
                  {frame >= t.submit + 68 && (
                    <div className="ssh-file-read">
                      <FileKey2 size={15} /> Reading README.md…
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="ssh-desktop-chin" />
        <div className="ssh-desktop-stand" />
        <div className="ssh-desktop-foot" />
      </div>
    </div>
  );
}
function KeyDialog({ save = false }: { save?: boolean }) {
  return (
    <div className="ssh-dialog-shade">
      <div className="ssh-key-dialog">
        <div className="ssh-dialog-title">
          <FileKey2 size={22} />
          {save ? "Save connection key" : "Choose SSH key"}
        </div>
        <div className="ssh-file-location">
          <Folder size={18} /> Downloads <ChevronDown size={16} />
        </div>
        <div className="ssh-file-row selected">
          <FileKey2 size={19} />
          <span>silo-demo.key</span>
          <small>SSH private key</small>
        </div>
        <div className="ssh-dialog-footer">
          <button>Cancel</button>
          <button className="primary">{save ? "Save" : "Choose key"}</button>
        </div>
      </div>
    </div>
  );
}
function Agent({ frame }: { frame: number }) {
  const folder = frame >= t.connected && frame < t.openProject;
  const coding = frame >= t.openProject;
  const settings = frame < t.connected;
  const filled = frame >= t.address;
  return (
    <div className="ssh-agent">
      <aside>
        <TrafficLights />
        <div className="ssh-agent-nav">
          <SquarePen size={19} /> New task
        </div>
        <div className="ssh-agent-nav">
          <Search size={19} /> Search
        </div>
        <div className="ssh-sidebar-label">
          Projects <Plus size={16} />
        </div>
        {coding ? (
          <div className="ssh-agent-project">
            <Folder size={18} /> hello-silo
            <ChevronDown size={15} />
          </div>
        ) : (
          <div className="ssh-sidebar-empty">Open a project to start</div>
        )}
        {coding && frame >= t.submit && (
          <div className="ssh-sidebar-task">Explore this codebase</div>
        )}
        <div className="ssh-agent-settings">
          <Settings2 size={18} /> Settings
        </div>
      </aside>
      <section className="ssh-agent-main">
        <header>
          <span>
            {settings ? "Settings" : coding ? "hello-silo" : "Open project"}
          </span>
          {!settings && (
            <span className="ssh-connection">
              <i /> SSH · Office Mac / demo VM <ChevronDown size={14} />
            </span>
          )}
        </header>
        {settings && (
          <div className="ssh-settings">
            <div className="ssh-settings-tabs">
              <span>General</span>
              <strong>Connections</strong>
              <span>Models</span>
            </div>
            <div className="ssh-settings-heading">
              <h1>SSH connections</h1>
              <button>
                <Plus size={16} /> Add connection
              </button>
            </div>
            <div
              className="ssh-connection-form"
              style={{ visibility: frame < t.add ? "hidden" : "visible" }}
            >
              <h2>Add SSH connection</h2>
              <label>
                Name
                <div className={frame < t.address ? "focus" : ""}>
                  {typed("Office Mac / demo VM", frame, t.name, 1.6) || (
                    <em>Connection name</em>
                  )}
                </div>
              </label>
              <label>
                Address
                <div
                  className={
                    frame >= t.address && frame < t.user ? "focus" : ""
                  }
                >
                  {filled ? "192.168.1.42:2222" : <em>hostname:port</em>}
                </div>
              </label>
              <label>
                User
                <div>
                  {typed("root", frame, t.user + 4, 1.6) || <em>Username</em>}
                </div>
              </label>
              <label>
                Private key
                <div className="ssh-key-input">
                  <span>
                    {frame >= t.keyChosen ? (
                      <>
                        <FileKey2 size={17} /> silo-demo.key
                      </>
                    ) : (
                      <em>Select a key file</em>
                    )}
                  </span>
                  <button>Choose file…</button>
                </div>
              </label>
              <div className="ssh-form-actions">
                <button>Cancel</button>
                <button className="primary">
                  {frame >= t.connect ? (
                    <>
                      <Loader2
                        size={16}
                        style={{ transform: `rotate(${frame * 12}deg)` }}
                      />{" "}
                      Connecting…
                    </>
                  ) : (
                    "Connect"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
        {folder && (
          <div className="ssh-folder-picker">
            <h1>Open a project</h1>
            <p>Choose a folder on Office Mac / demo VM.</p>
            <div className="ssh-folder-path">
              <Globe size={17} />
              <span>/workspace</span>
            </div>
            <div
              className={`ssh-folder-row ${frame >= t.selectFolder ? "selected" : ""}`}
            >
              <Folder size={23} />
              <span>hello-silo</span>
              <small>Git repository</small>
              <ChevronRight size={17} />
            </div>
            <div className="ssh-folder-preview">
              <span>package.json</span>
              <span>src/</span>
              <span>README.md</span>
            </div>
            <div className="ssh-form-actions">
              <button>Cancel</button>
              <button className="primary">Open project</button>
            </div>
          </div>
        )}
        {coding && (
          <div className="ssh-conversation">
            {frame < t.submit ? (
              <div className="ssh-start">
                <div className="ssh-project-symbol">
                  <Code2 size={31} />
                </div>
                <h1>hello-silo</h1>
                <p>What would you like to build?</p>
              </div>
            ) : (
              <div className="ssh-submitted">
                <div>Explore this codebase</div>
                <p>
                  <span className="ssh-thinking" /> Working in demo VM…
                </p>
              </div>
            )}
            <div className="ssh-composer">
              <div>
                {frame >= t.submit ? (
                  <em>Ask a follow-up…</em>
                ) : (
                  typed("Explore this codebase", frame, t.prompt + 4, 1.6) || (
                    <em>Ask anything, or describe a task</em>
                  )
                )}
              </div>
              <footer>
                <Plus size={20} />
                <span>
                  Code <ChevronDown size={13} />
                </span>
                <span>
                  Auto <ChevronDown size={13} />
                </span>
                <button
                  className={
                    frame >= t.prompt + 5 && frame < t.submit ? "ready" : ""
                  }
                >
                  <ArrowUp size={19} />
                </button>
              </footer>
            </div>
            <div className="ssh-workspace-footer">
              <Terminal size={14} />
              <span>/workspace/hello-silo</span>
              <GitBranch size={14} />
              <span>main</span>
            </div>
          </div>
        )}
      </section>
      {frame >= t.chooseKey && frame < t.keyChosen && <KeyDialog />}
    </div>
  );
}
export function SshFilm({ frameOverride }: { frameOverride?: number } = {}) {
  const currentFrame = useCurrentFrame();
  const frame = frameOverride ?? currentFrame;
  const silo = frame < t.agent;
  const camera = sshCamera(frame);
  return (
    <AbsoluteFill className="film ssh-film">
      <div
        className="device-tag"
        style={{ opacity: Math.max(0, 1 - camera.zoom * 4) }}
      >
        <Laptop size={20} />
        <strong>My laptop</strong>
        <span>{silo ? "Silo · managing Office Mac" : "Agent app"}</span>
      </div>
      {!silo && <TwoComputers frame={frame} zoom={camera.zoom} />}
      {silo ? (
        <>
          <SiloSsh key={frame} frame={frame} />
          {frame >= t.saveDialog && frame < t.saveClose && (
            <div className="ssh-save-overlay">
              <KeyDialog save />
            </div>
          )}
          <Pointer frame={frame} points={siloCursor} />
        </>
      ) : (
        <div
          className="ssh-camera"
          style={{
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          }}
        >
          <Agent frame={frame} />
          <Pointer frame={frame} points={agentCursor} />
        </div>
      )}
    </AbsoluteFill>
  );
}

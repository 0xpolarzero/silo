// Captures the website's light and dark product screenshots from the read-only demo.
// Usage: start `npm --prefix website run dev`, then `node website/scripts/capture-media.mjs [name…]`.
// Requires Google Chrome; set CHROME to another Chromium binary if needed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const origin = process.env.SITE ?? "http://127.0.0.1:4173";
const media = new URL("../public/media/", import.meta.url).pathname;
const port = 9333;

const shots = {
  overview: { height: 720, steps: [["nav", "All computers"]] },
  tools: { height: 720, steps: [["nav", "All computers"], ["click", "button[aria-label='SSH from Office Mac and other devices']"]] },
  network: { height: 720, steps: [["nav", "Network"]] },
  github: { height: 800, steps: [["nav", "GitHub"]] },
  secrets: { height: 800, steps: [["nav", "Secrets"]] },
  backup: { height: 800, url: () => `${origin}/demo.html?capture=export`, steps: [["nav", "All computers"], ["click", "button[aria-label='More actions for dev']"]] },
};

// The embed is transparent on the landing page; captures paint its gradient and ribbon behind it (src/style.css .showcase-wallpaper).
const wallpaper = theme => `(() => {
  const style = document.createElement("style");
  style.textContent = \`
    html { background: ${theme === "dark" ? "#101e26" : "#e9eeed"}; }
    .capture-wallpaper { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; opacity: ${theme === "dark" ? ".48" : "1"};
      background: radial-gradient(ellipse at 1% 75%, #307e84, transparent 46%), radial-gradient(ellipse at 94% 13%, #a7b8da, transparent 47%), radial-gradient(ellipse at 80% 97%, #c6dcd3, transparent 55%); }
    .capture-wallpaper span { position: absolute; border-radius: 50%; }
    .capture-ribbon { width: 120%; height: 330px; left: -30%; top: 45%; transform: rotate(-32deg); background: linear-gradient(180deg, #ddf8ef00, #effff099 25%, #5eb0a9aa 26%, #13778255 31%, #d8f7d766 75%, transparent); }
\`;
  document.head.append(style);
  const layer = document.createElement("div");
  layer.className = "capture-wallpaper";
  layer.innerHTML = '<span class="capture-ribbon"></span>';
  document.body.prepend(layer);
})()`;

const wanted = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), "silo-capture-"));
const browser = spawn(chrome, ["--headless=new", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  let target;
  for (let attempt = 0; !target && attempt < 50; attempt++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then(list => list.find(t => t.type === "page")).catch(() => undefined);
  }
  if (!target) throw new Error("Chrome did not start");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const clickNav = label => evaluate(`(() => {
    const item = [...document.querySelectorAll("nav a, nav button")].find(el => el.textContent.trim().replace(/⌘.*$/, "") === ${JSON.stringify(label)});
    if (!item) throw new Error("No navigation item " + ${JSON.stringify(label)});
    item.click();
  })()`);
  const click = selector => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("No element " + ${JSON.stringify(selector)});
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) element.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerType: "mouse" }));
  })()`);

  for (const [name, shot] of Object.entries(shots)) {
    if (wanted.length && !wanted.includes(name)) continue;
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: shot.height, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
      await send("Page.navigate", { url: shot.url?.(theme) ?? `${origin}/demo.html` });
      await sleep(2500);
      await evaluate(wallpaper(theme));
      for (const [kind, value] of shot.steps) {
        if (kind === "nav") await clickNav(value);
        else await click(value);
        await sleep(900);
      }
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const file = join(media, theme === "dark" ? `${name}-dark.png` : `${name}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(file);
    }
  }
  socket.close();
} finally {
  browser.kill("SIGTERM");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

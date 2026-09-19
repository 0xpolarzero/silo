import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("out/stills", { recursive: true });
const ssh = process.argv.includes("--ssh");
const shots = ssh
  ? {
      sshClosed: 15,
      sshLocal: 70,
      sshNetwork: 98,
      sshCopied: 120,
      sshMenu: 168,
      sshSaveKey: 195,
      sshSettings: 242,
      sshAddress: 355,
      sshChooseKey: 400,
      sshReady: 440,
      sshZoomStart: 453,
      sshZoomMiddle: 480,
      sshConnected: 520,
      sshFolder: 565,
      sshPrompt: 655,
      sshWorking: 700,
      sshRemoteActivity: 790,
    }
  : {
      opening: 20,
      github: 90,
      secrets: 190,
      secretSaved: 235,
      backup: 280,
      enable: 330,
      paste: 380,
      connected: 438,
      handoffStart: 467,
      handoffRunning: 565,
      terminal: 642,
      network: 685,
      initialBrowser: 742,
      sshSetup: 900,
      sshClient: 1100,
      sshZoom: 1155,
      sshConnected: 1200,
      sshPrompt: 1285,
      sshRemoteActivity: 1365,
      outro: 1410,
    };
for (const [name, frame] of Object.entries(shots)) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@remotion/cli/remotion-cli.js",
      "still",
      "src/index.ts",
      ssh ? "SiloSshDemo" : "SiloDemo",
      `out/stills/${name}.png`,
      `--frame=${frame}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

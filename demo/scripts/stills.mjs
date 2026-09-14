import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("out/stills", { recursive: true });
const shots = {
  opening: 20, github: 90, secrets: 190, secretSaved: 235,
  backup: 280, enable: 330, paste: 380, connected: 438,
  handoffStart: 467, handoffRunning: 565, terminal: 642,
  network: 685, initialBrowser: 742, files: 810,
  editBeforeSave: 945, liveUpdate: 995, outro: 1035,
};
for (const [name, frame] of Object.entries(shots)) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@remotion/cli/remotion-cli.js",
      "still",
      "src/index.ts",
      "SiloDemo",
      `out/stills/${name}.png`,
      `--frame=${frame}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export const sshTiming = {
  expand: 24,
  local: 54,
  network: 84,
  copy: 114,
  menu: 144,
  saveDialog: 174,
  saveClose: 210,
  agent: 230,
  add: 254,
  name: 264,
  address: 315,
  user: 337,
  chooseKey: 373,
  keyChosen: 413,
  connect: 453,
  connected: 513,
  selectFolder: 549,
  openProject: 585,
  prompt: 621,
  submit: 681,
  duration: 810,
} as const;

export type CursorStop = readonly [
  frame: number,
  x: number,
  y: number,
  click?: boolean,
];
const t = sshTiming;
export const siloCursor: CursorStop[] = [
  [0, 1400, 360],
  [t.expand, 1590, 329, true],
  [t.local, 1670, 399, true],
  [t.network, 1670, 484, true],
  [t.copy, 1638, 520, true],
  [t.menu, 1677, 520, true],
  [t.saveDialog, 1585, 616, true],
  [t.saveClose, 1230, 654, true],
];
export const agentCursor: CursorStop[] = [
  [t.agent, 1370, 340],
  [t.add, 1400, 313, true],
  [t.name, 1020, 477],
  [t.address, 1000, 565, true],
  [t.user, 1010, 655, true],
  [t.chooseKey, 1390, 743, true],
  [t.keyChosen, 1205, 661, true],
  [t.connect, 1398, 805, true],
  [t.selectFolder, 865, 481, true],
  [t.openProject, 1425, 628, true],
  [t.prompt, 980, 790, true],
  [t.submit, 1528, 855, true],
];

// Arrive five frames before each action, then hold through its result.
// Longer journeys take longer; smoothstep removes abrupt starts and stops.
export function cursorAt(frame: number, stops: readonly CursorStop[]) {
  const next = stops.findIndex((stop) => frame < stop[0]);
  const index = next < 0 ? stops.length - 1 : next;
  const to = stops[index];
  const from = stops[Math.max(0, index - 1)];
  const distance = Math.hypot(to[1] - from[1], to[2] - from[2]);
  const arrival = to[0] - 5;
  const start = Math.max(
    from[0] + 5,
    arrival - Math.min(20, Math.max(8, distance / 35)),
  );
  const progress =
    index === 0 || frame >= arrival
      ? 1
      : Math.max(
          0,
          Math.min(1, (frame - start) / Math.max(1, arrival - start)),
        );
  const eased = progress * progress * (3 - 2 * progress);
  const pressed = stops.some(
    (stop) => stop[3] && frame >= stop[0] - 1 && frame < stop[0] + 3,
  );
  return {
    x: from[1] + (to[1] - from[1]) * eased,
    y: from[2] + (to[2] - from[2]) * eased,
    pressed,
  };
}

// One continuous camera move. The same app and cursor remain mounted afterward.
export function sshCamera(frame: number) {
  const progress = Math.max(0, Math.min(1, (frame - t.connect) / 48));
  const zoom = progress * progress * (3 - 2 * progress);
  return { zoom, x: 13 * zoom, y: 238.6 * zoom, scale: 1 - 0.43 * zoom };
}

// Main film: shorter pauses and entry beats, retaining the 48-frame pullback.
export const mainSshFrames = 600;
const mainSshBeats = [
  [0, 0],
  [18, t.expand],
  [42, t.local],
  [66, t.network],
  [90, t.copy],
  [114, t.menu],
  [138, t.saveDialog],
  [165, t.saveClose],
  [180, t.agent],
  [198, t.add],
  [206, t.name],
  [229, 295],
  [240, t.address],
  [256, t.user],
  [282, t.chooseKey],
  [309, t.keyChosen],
  [336, t.connect],
  [384, t.connect + 48],
  [396, t.connected],
  [420, t.selectFolder],
  [444, t.openProject],
  [468, t.prompt],
  [510, t.submit],
  [mainSshFrames - 1, t.duration - 1],
] as const;
export function mainSshFrame(frame: number) {
  const bounded = Math.max(0, Math.min(mainSshFrames - 1, frame));
  const index = mainSshBeats.findIndex((beat) => beat[0] >= bounded);
  if (index === 0) return 0;
  const from = mainSshBeats[index - 1],
    to = mainSshBeats[index];
  return Math.round(
    from[1] + ((to[1] - from[1]) * (bounded - from[0])) / (to[0] - from[0]),
  );
}

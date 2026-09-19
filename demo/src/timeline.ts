import { mainSshFrame, mainSshFrames, sshTiming } from "./ssh-timeline.ts";
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
// Source frames select fixture states. Camera framing stays fixed within each shot.
const originalScenes = [
  { id: "intro", start: 0, end: 1, sourceStart: 0, sourceEnd: 29 },
  { id: "github", start: 1, end: 5, sourceStart: -5, sourceEnd: 155 },
  { id: "secrets", start: 5, end: 8, sourceStart: 10, sourceEnd: 175 },
  { id: "backup", start: 8, end: 10, sourceStart: 40, sourceEnd: 170 },
  { id: "enable", start: 10, end: 12, sourceStart: 65, sourceEnd: 250 },
  { id: "connect", start: 12, end: 15, sourceStart: 45, sourceEnd: 260 },
  { id: "handoff", start: 15, end: 20, sourceStart: 10, sourceEnd: 155 },
  { id: "terminal", start: 20, end: 22, sourceStart: 5, sourceEnd: 100 },
  { id: "network", start: 22, end: 26.5, sourceStart: 0, sourceEnd: 280 },
  { id: "files", start: 26.5, end: 28, sourceStart: 0, sourceEnd: 120 },
  { id: "edit", start: 28, end: 34, sourceStart: 0, sourceEnd: 240 },
  { id: "outro", start: 34, end: 35, sourceStart: 0, sourceEnd: 29 },
] as const;
// Keep the existing preparation, handoff and browser sequence intact.
export const scenes = [
  ...originalScenes.slice(0, 9),
  {
    id: "ssh",
    start: 26.5,
    end: 26.5 + mainSshFrames / FPS,
    sourceStart: 0,
    sourceEnd: sshTiming.duration - 1,
  },
  {
    id: "outro",
    start: 26.5 + mainSshFrames / FPS,
    end: 27.5 + mainSshFrames / FPS,
    sourceStart: 0,
    sourceEnd: 29,
  },
] as const;
export type Scene = (typeof scenes)[number];
export type SceneId = Scene["id"];
export const DURATION = scenes.at(-1)!.end * FPS;
export function sceneAt(frame: number): Scene {
  const seconds = Math.max(0, Math.min(DURATION - 1, Math.floor(frame))) / FPS;
  return scenes.find((scene) => seconds >= scene.start && seconds < scene.end)!;
}
export function sourceFrameAt(frame: number): number {
  const scene = sceneAt(frame);
  if (scene.id === "ssh") return mainSshFrame(frame - scene.start * FPS);
  const progress = Math.max(
    0,
    Math.min(
      1,
      (frame - scene.start * FPS) / ((scene.end - scene.start) * FPS - 1),
    ),
  );
  return Math.round(
    scene.sourceStart + (scene.sourceEnd - scene.sourceStart) * progress,
  );
}
export function typed(
  text: string,
  frame: number,
  start: number,
  framesPerCharacter = 1.6,
): string {
  return text.slice(
    0,
    Math.max(0, Math.floor((frame - start) / framesPerCharacter)),
  );
}

export const pastedAddress = (address: string, frame: number) =>
  frame < 85 ? "" : address;
export const liveEditState = (frame: number) => ({
  saved: frame >= 155,
  browserUpdated: frame >= 170,
});

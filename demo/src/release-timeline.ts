export const RELEASE_FPS = 30;
export const RELEASE_DURATION = 54 * RELEASE_FPS;

export const releaseScenes = [
  { id: 'opening', from: 0, duration: 150 },
  { id: 'desktop', from: 150, duration: 300 },
  { id: 'computers', from: 450, duration: 240 },
  { id: 'tools', from: 690, duration: 240 },
  { id: 'github', from: 930, duration: 150 },
  { id: 'secrets', from: 1080, duration: 150 },
  { id: 'preview', from: 1230, duration: 210 },
  { id: 'closing', from: 1440, duration: 180 },
] as const;

export function agentTaskAt(frame: number) {
  return {
    observe: frame >= 52,
    click: frame >= 112,
    created: frame >= 148,
    checked: frame >= 190,
  };
}

export const RELEASE_FPS = 30;
export const RELEASE_DURATION = 59 * RELEASE_FPS;

export const releaseScenes = [
  { id: 'opening', from: 0, duration: 90 },
  { id: 'desktop', from: 90, duration: 240 },
  { id: 'computers', from: 330, duration: 150 },
  { id: 'tools', from: 480, duration: 150 },
  { id: 'ssh', from: 630, duration: 330 },
  { id: 'github', from: 960, duration: 150 },
  { id: 'secrets', from: 1110, duration: 150 },
  { id: 'backup', from: 1260, duration: 150 },
  { id: 'preview', from: 1410, duration: 210 },
  { id: 'closing', from: 1620, duration: 150 },
] as const;

export function agentTaskAt(frame: number) {
  return {
    observe: frame >= 52,
    click: frame >= 112,
    created: frame >= 148,
    checked: frame >= 190,
  };
}

export function releaseSshAt(frame: number) {
  return {
    local: frame >= 30,
    network: frame >= 60,
    copied: frame >= 88,
    keyMenu: frame >= 108 && frame < 150,
    keySaved: frame >= 150,
    connecting: frame >= 205,
    connected: frame >= 230,
    working: frame >= 285,
  };
}

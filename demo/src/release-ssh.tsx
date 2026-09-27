import { useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender, Easing, interpolate } from 'remotion';
import { Check, FileKey2, Folder, Laptop, Monitor, MousePointer2, Terminal } from 'lucide-react';
import { SshAccessRow } from '@/features/application/pages/ssh-access-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { showcaseSource } from './showcase-fixtures';
import { releaseSshAt } from './release-timeline';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const move = (f: number, start: number, duration: number, a = 0, b = 1) => interpolate(f, [start, start + duration], [a, b], { ...clamp, easing: Easing.bezier(.22, 1, .36, 1) });
const noop = async () => undefined;

/** A magnified production SSH row; external agent client and key handoff are illustrations. */
export function ReleaseSsh({ frame }: { frame: number }) {
  const state = releaseSshAt(frame);
  const surface = useRef<HTMLDivElement>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const workspace = showcaseSource.workspaces[2];
  // Fresh production controls per action phase make arbitrary/reverse seeks exact.
  const phase = state.keySaved ? 'saved' : state.keyMenu ? 'menu' : state.copied ? 'copied' : state.network ? 'network' : state.local ? 'local' : 'off';
  useLayoutEffect(() => {
    const handle = delayRender('Stage production SSH controls');
    let cancelled = false;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
    const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    async function stage() {
      const toggle = surface.current?.querySelector<HTMLButtonElement>('[aria-label="SSH controls for lab"]');
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
      await tick();
      if (cancelled) return;
      if (phase === 'copied') surface.current?.querySelector<HTMLButtonElement>('[aria-label="Copy network SSH address"]')?.click();
      if (state.keyMenu) surface.current?.querySelector<HTMLButtonElement>('[aria-label="More network SSH actions"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      if (cancelled) return;
      const selector = phase === 'off' ? '[role="switch"][aria-label="Allow SSH from Studio Mac"]'
        : phase === 'local' ? '[role="switch"][aria-label="Allow SSH from other computers"]'
        : phase === 'menu' ? '[aria-label="Save network SSH key file"]'
        : '[aria-label="Copy network SSH address"], [aria-label="SSH address copied"]';
      const target = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      if (target) {
        const origin = surface.current!.closest('.r-ssh-scene')!.getBoundingClientRect();
        setPointer({ x: target.x + target.width / 2 - origin.x, y: target.y + target.height / 2 - origin.y });
      }
      if (!cancelled) continueRender(handle);
    }
    void stage();
    return () => {
      cancelled = true;
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      continueRender(handle);
    };
  }, [phase, state.keyMenu]);

  const prompt = 'Review this project.'.slice(0, Math.max(0, Math.floor((frame - 248) / 1.6)));
  return <div className="r-ssh-scene">
    <div className="r-ssh-owner"><Monitor size={25} /><strong>Studio Mac</strong><span>lab · Linux sandbox</span></div>
    <div className="r-ssh-source" ref={surface}>
      <div className="r-ssh-source-label">SILO / SSH ACCESS</div>
      <div className="r-ssh-production" key={phase}><TooltipProvider>
        <SshAccessRow workspace={workspace} stale={false} save={noop} connection={async () => null}
          access={{ workspace: workspace.machine.id, computerName: 'Studio Mac', enabled: state.local, bindAddress: state.network ? '192.168.1.42' : '127.0.0.1', port: 2222, addresses: ['192.168.1.42'], keys: [], state: state.local ? 'listening' : 'disabled', message: null, fingerprint: null }} />
      </TooltipProvider></div>
    </div>
    {pointer && frame < 150 && <div className="r-ssh-pointer" style={{ left: pointer.x, top: pointer.y }}><MousePointer2 size={31} fill="#f6f2e9" stroke="#202c29" strokeWidth={1.7} /></div>}
    {frame >= 185 && frame < 236 && <div className="r-ssh-pointer" style={{ left: move(frame, 185, 17, 1680, 1550), top: move(frame, 185, 17, 840, 711), transform: `scale(${frame >= 205 && frame < 211 ? .88 : 1})` }}><MousePointer2 size={31} fill="#f6f2e9" stroke="#202c29" strokeWidth={1.7} /></div>}
    <div className="r-ssh-key" style={{ opacity: move(frame, 150, 18), transform: `translateY(${move(frame, 150, 25, 20, 0)}px)` }}><FileKey2 size={25} /><div><strong>lab-ssh-key</strong><span>Use this key in your SSH client</span></div><Check size={22} /></div>
    <div className="r-ssh-handoff" style={{ opacity: move(frame, 155, 20), transform: `scaleX(${move(frame, 155, 35)})` }}><span>SSH</span><i /></div>
    <div className="r-ssh-client" style={{ opacity: move(frame, 156, 24), transform: `translateY(${move(frame, 156, 36, 60, 0)}px)` }}>
      <div className="r-native-title"><span><Laptop size={16} />Your laptop · Agent client</span><span>−　□　×</span></div>
      <div className="r-ssh-client-body"><span className="r-mono-label">ILLUSTRATED AGENT CLIENT</span>
        <h2>Connect to your sandbox</h2>
        <label>SSH address</label><div className="r-ssh-field">root@192.168.1.42:2222</div>
        <label>Identity file</label><div className="r-ssh-field"><FileKey2 size={17} />lab-ssh-key <Check size={17} /></div>
        <div className={`r-ssh-connect ${state.connected ? 'is-connected' : ''}`}>{state.connected ? <><Check size={18} />Connected to lab</> : state.connecting ? 'Connecting…' : 'Connect'}</div>
        <div className="r-ssh-repo" style={{ opacity: move(frame, 235, 15) }}><Folder size={18} />/workspace/experiments</div>
        <div className="r-ssh-prompt" style={{ opacity: move(frame, 248, 12) }}><span>›</span>{prompt}</div>
        <div className="r-ssh-work" style={{ opacity: move(frame, 285, 14) }}><Terminal size={17} /><span>Reading README.md <small>inside lab on Studio Mac</small></span></div>
      </div>
    </div>
    <div className="r-ssh-caption" style={{ opacity: move(frame, 95, 20) }}>Enable SSH. Save the key. Bring your agent.</div>
  </div>;
}

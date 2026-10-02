// Drives the Silo guest desktop through LCU's own MCP client, with no model. Pushed into
// the guest and run as the `silo` account inside the desktop session by the live test
// `live_lcu_drives_the_desktop_without_a_model`. Prints `MARK <name> <value>` lines the test
// checks; the saved files are verified independently by the test, not by this script.
//
// DRIVE_MODE=probe only reports whether the default configuration can reach the X server.
// E2E_NO_SANDBOX=1 starts LCU's server without the node_repl sandbox (see the test).
import { createCuaClient } from '/opt/lcu/current/adapters/client.mjs';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';

const mark = (name, value) => console.log(`MARK ${name} ${value}`);
const noSandbox = process.env.E2E_NO_SANDBOX === '1';
const client = createCuaClient({
  command: ['/opt/lcu/current/bin/lcu'],
  cwd: '/home/silo',
  env: noSandbox ? { ...process.env, CODEX_CLI_PATH: '' } : undefined,
});
await client.connect();
const ids = { sessionId: 'e2e-session', turnId: 'e2e-turn-1' };
const show = r => (r.content ?? []).map(c => c.type === 'text' ? c.text : `[${c.type} ${(c.data ?? '').length} bytes]`).join('\n') + (r.isError ? '\n(isError)' : '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = async (label, code, limit = 300) => {
  const out = show(await client.call('js', { code }, ids));
  console.log(`--- ${label}\n${out.slice(0, limit)}`);
  return out;
};
const listJs = 'nodeRepl.write(JSON.stringify((await cua.listWindows({ emit: false })).filter(x => !/^(Xfce4-panel|Xfdesktop|x11:|Xfwm|Wrapper)/.test(x.app)).map(x => [x.id, x.app, x.title, x.focused, x.modal, x.window_type])));';
const windows = async label => JSON.parse((await js(label, listJs, 1500)).split('\n').find(l => l.startsWith('[')) ?? '[]');
const processes = name => { try { return execSync(`pgrep -x ${name}`).toString().trim().split('\n').length; } catch { return 0; } };
const keyName = c => ({ ' ': 'space', '-': 'minus', '>': 'greater', '/': 'slash', '.': 'period', "'": 'apostrophe', '_': 'underscore', '\n': 'Return' }[c] ?? c);

const first = await js('get-state', 'nodeRepl.write(JSON.stringify(await cua.getState({ emit: false })));', 200);
const x11Denied = /Could not connect to X11/.test(first);
mark('x11-reachable', x11Denied ? 'no' : 'yes');
if (process.env.DRIVE_MODE === 'probe') {
  await client.close();
  process.exit(0);
}
if (x11Denied) {
  console.log('The X server is not reachable from LCU; nothing can be driven.');
  await client.close();
  process.exit(3);
}

const OUT = '/home/silo/e2e-lcu-out';
const PERKEY = '/tmp/e2e-perkey.txt';
for (const file of readdirSync('/home/silo').filter(f => f.startsWith('e2e-lcu-out'))) rmSync(`/home/silo/${file}`, { force: true });
rmSync(PERKEY, { force: true });
try { execSync('pkill -x gnome-text-edit; pkill -x xfce4-terminal; sleep 2'); } catch {}
execSync('rm -rf /home/silo/.local/share/org.gnome.TextEditor');

// 1. GTK4 editor: typeText and paste must not crash it; Save As through the dialog.
spawn('gnome-text-editor', ['--standalone'], { detached: true, stdio: 'ignore' }).unref();
await sleep(6000);
const editor = (await windows('windows')).find(x => /Text Editor/.test(x[2]));
mark('editor-window', editor ? 'found' : 'missing');
const step = (label, body, limit) => js(label, `const app = await cua.getApp({ windowId: ${editor[0]} }); ${body}`, limit ?? 200);
await step('typeText', `await app.typeText('typed-by-typeText\\n'); nodeRepl.write('done');`);
await step('paste', `await app.paste('pasted-text caf\\u00e9\\nline2\\n'); nodeRepl.write('done');`);
mark('editor-processes-after-text', processes('gnome-text-edit'));
await step('screenshot', `const shot = await app.getScreenshot({ emit: false }); const fs = await import('node:fs'); fs.writeFileSync('/tmp/e2e-shot-typed.png', shot); nodeRepl.write('screenshot ' + shot.length);`);
await step('save-as', `await app.performSecondaryAction(0, 'page.save-as'); nodeRepl.write('invoked');`);
await sleep(4000);
const dialog = (await windows('windows-dialog')).find(x => x[2] === 'Save As');
mark('save-dialog', dialog ? 'found' : 'missing');
await js('save-name', `const d = await cua.getApp({ windowId: ${dialog[0]} }); await d.typeText(${JSON.stringify(OUT)}); nodeRepl.write('typed name');`);
await js('save-confirm', `const d = await cua.getApp({ windowId: ${dialog[0]} }); const st = await d.getAXState({ emit: false }); const idx = Number(st.match(/^\\s*(\\d+) dialog/m)[1]); await d.performSecondaryAction(idx, 'default.activate'); nodeRepl.write('activated');`);
await sleep(3000);
mark('editor-processes-after-save', processes('gnome-text-edit'));
mark('saved-files', JSON.stringify(readdirSync('/home/silo').filter(f => f.startsWith('e2e-lcu-out'))));

// 2. Per-key typing into a terminal (GTK3 and VTE): the keys must reach the shell.
spawn('xfce4-terminal', ['--disable-server'], { detached: true, stdio: 'ignore' }).unref();
await sleep(5000);
const terminal = (await windows('windows-terminal')).find(x => /Terminal/i.test(x[1] + x[2]));
mark('terminal-window', terminal ? 'found' : 'missing');
const command = `echo perkey-ok>${PERKEY}\n`;
await js('per-key', `const t = await cua.getApp({ windowId: ${terminal[0]} }); for (const k of ${JSON.stringify([...command].map(keyName))}) await t.pressKey(k); nodeRepl.write('keys sent');`);
await sleep(1500);
mark('perkey-file', existsSync(PERKEY) ? 'present' : 'missing');
await js('screenshot-terminal', `const t = await cua.getApp({ windowId: ${terminal[0]} }); const shot = await t.getScreenshot({ emit: false }); const fs = await import('node:fs'); fs.writeFileSync('/tmp/e2e-shot-terminal.png', shot); nodeRepl.write('screenshot ' + shot.length);`);
await client.turnEnded({ ...ids }).catch(e => console.log('turnEnded', String(e)));
await client.close();
mark('done', 'yes');

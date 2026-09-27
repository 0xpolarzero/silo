import { bundle } from '@remotion/bundler';
import { openBrowser, selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const out = path.resolve('out/release');
await mkdir(out, { recursive: true });
const serveUrl = await bundle({
  entryPoint: path.resolve('src/index.ts'),
  webpackOverride: config => ({ ...config, resolve: { ...config.resolve, alias: {
    ...config.resolve?.alias,
    '@': path.resolve('../app/SiloUI/src'),
    react: path.resolve('node_modules/react'),
    'react-dom': path.resolve('node_modules/react-dom'),
  } } }),
});
const browser = await openBrowser('chrome');
try {
  const composition = await selectComposition({ serveUrl, id: 'SiloRelease', puppeteerInstance: browser });
  if (composition.durationInFrames / composition.fps > 60) throw new Error('Release exceeds 60 seconds');
  const frames = process.argv.includes('--stills')
    ? [90, 210, 280, 365, 430, 560, 740, 875, 1020, 1160, 1270, 1370, 1540, 1619]
    : [90, 365, 560, 875, 1020, 1160, 1270, 1310, 1370, 1540];
  for (const frame of frames) {
    await renderStill({ composition, serveUrl, puppeteerInstance: browser, frame, output: path.join(out, `frame-${String(frame).padStart(4, '0')}.png`), imageFormat: 'png', logLevel: 'warn' });
    console.log(`Rendered frame ${frame}`);
  }
  if (!process.argv.includes('--stills')) {
    let last = -1;
    await renderMedia({ composition, serveUrl, puppeteerInstance: browser, codec: 'h264', crf: 17,
      outputLocation: path.join(out, 'silo-release.mp4'), pixelFormat: 'yuv420p', muted: true,
      concurrency: 4, imageFormat: 'jpeg', jpegQuality: 95,
      onProgress: ({ progress }) => { const pct = Math.floor(progress * 10) * 10; if (pct !== last) { last = pct; console.log(`Render ${pct}%`); } },
    });
  }
  await writeFile(path.join(out, 'composition.json'), JSON.stringify({ id: composition.id, width: composition.width, height: composition.height, fps: composition.fps, frames: composition.durationInFrames, seconds: composition.durationInFrames / composition.fps, data: 'deterministic fixtures; illustrated agent, editor and browser', audio: 'silent' }, null, 2));
} finally {
  await browser.close({ silent: true });
}

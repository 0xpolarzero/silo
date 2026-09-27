import { bundle } from '@remotion/bundler';
import { openBrowser, selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { releaseScenes, RELEASE_FPS } from '../src/release-timeline.ts';

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
  const storyFrames = releaseScenes.map(scene => scene.from + Math.min(scene.duration - 1, scene.id === 'ssh' ? 310 : scene.id === 'backup' ? 125 : scene.id === 'desktop' ? 220 : 120));
  const detailFrames = [645, 670, 700, 730, 770, 820, 900, 1300, 1450, 1490, composition.durationInFrames - 1];
  const frames = [...new Set([...storyFrames, ...(process.argv.includes('--stills') ? detailFrames : [770, 1300, 1450, 1490])])].sort((a, b) => a - b);
  for (const frame of frames) {
    await renderStill({ composition, serveUrl, puppeteerInstance: browser, frame, output: path.join(out, `frame-${String(frame).padStart(4, '0')}.png`), imageFormat: 'png', logLevel: 'warn' });
    console.log(`Rendered frame ${frame}`);
  }
  await renderStill({ composition, serveUrl, puppeteerInstance: browser, frame: 2 * RELEASE_FPS, output: path.join(out, 'silo-release-poster.png'), imageFormat: 'png', logLevel: 'warn' });
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

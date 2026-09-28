import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../../app/SiloUI');
const require = createRequire(process.env.SILO_VIDEO_NODE_MODULES ? path.join(process.env.SILO_VIDEO_NODE_MODULES,'package.json') : '/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { chromium } = require('playwright');
const { createServer } = await import(path.join(root,'node_modules/vite/dist/node/index.js'));
const entry = path.join(root, 'src/__film_capture.tsx');
const source = await readFile(path.join(here,'capture.tsx'),'utf8');
const server = await createServer({root, configFile:path.join(root,'vite.config.ts'), server:{port:17341,host:'127.0.0.1',strictPort:true}, plugins:[{
  name:'film-capture',
  resolveId(id){if(id==='/src/__film_capture.tsx') return entry},
  load(id){if(id===entry) return source},
  configureServer(s){s.middlewares.use(async(req,res,next)=>{if(!req.url.startsWith('/film-capture'))return next(); const html=await s.transformIndexHtml(req.url,'<html><head></head><body><div id="root"></div><script type="module" src="/src/__film_capture.tsx"></script></body></html>');res.setHeader('Content-Type','text/html');res.end(html)})}
}]});
await server.listen();
const browser = await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1160,height:740},deviceScaleFactor:2,colorScheme:'dark'});
 page.on('pageerror',e=>console.error(e.message));
 for(const scene of ['overview','files','network','github','secrets','backup']){
  await page.goto(`http://127.0.0.1:17341/film-capture?scene=${scene}`);
  await page.locator('.silo-application').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(here,'assets',scene+'.png')});
  await writeFile(path.join(here,'assets',scene+'.txt'),await page.locator('body').innerText());
  console.log('Captured',scene);
 }
}finally{await browser.close();await server.close()}

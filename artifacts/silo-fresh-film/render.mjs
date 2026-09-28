import {bundle} from '@remotion/bundler';
import {selectComposition,renderMedia,renderStill} from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const prod=path.resolve(root,'../../app/SiloUI/src');
const serveUrl=await bundle({entryPoint:path.join(root,'src/index.tsx'),publicDir:path.join(root,'public'),outDir:path.join(root,'build'),webpackOverride:(c)=>({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,'@':prod,'@prod':prod,'react':path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')},modules:[path.join(root,'node_modules'),'node_modules']}})});
const browserExecutable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const composition=await selectComposition({serveUrl,id:'Silo',browserExecutable});
const arg=process.argv.find(x=>x.startsWith('--frames='));
const frames=arg?arg.split('=')[1].split(',').map(Number):[32,144,240,320,384,464,640,720,880,976,1056,1168,1312,1472,1632,1720];
fs.mkdirSync(path.join(root,'final/stills'),{recursive:true});
for(const frame of frames){await renderStill({composition,serveUrl,frame,output:path.join(root,`final/stills/frame-${String(frame).padStart(4,'0')}.png`),browserExecutable,logLevel:'error'});console.log('Still',frame)}
if(!process.argv.includes('--stills')){
 const range=process.argv.find(x=>x.startsWith('--range='));
 let lastProgress=-1;
 await renderMedia({composition,serveUrl,codec:'h264',crf:17,pixelFormat:'yuv420p',outputLocation:path.join(root,range?'final/passage.mp4':'final/silo-picture.mp4'),browserExecutable,concurrency:4,frameRange:range?range.split('=')[1].split(',').map(Number):undefined,onProgress:({progress})=>{const pct=Math.floor(progress*10)*10;if(pct!==lastProgress){lastProgress=pct;console.log('Render',pct+'%')}}});
}

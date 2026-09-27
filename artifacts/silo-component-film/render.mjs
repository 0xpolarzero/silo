import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition, openBrowser} from '@remotion/renderer';
import {enableTailwind} from '@remotion/tailwind-v4';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const root=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(root,'../../app/SiloUI');
const output=path.join(root,'output');fs.mkdirSync(output,{recursive:true});
const args=process.argv.slice(2);
const studies=args.includes('--studies'),stills=args.includes('--stills'),draft=args.includes('--draft');
const frameArg=args.indexOf('--frame');
const serveUrl=await bundle({entryPoint:path.join(root,'Film.tsx'),publicDir:path.join(root,'assets'),outDir:path.join(root,'build'),webpackOverride:(c)=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,'@':path.join(app,'src'),'react':path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')},modules:[path.join(root,'node_modules'),path.join(app,'node_modules'),'node_modules']}})});
console.log('Composition bundled');
const browser=await openBrowser('chrome');
try{
 const composition=await selectComposition({serveUrl,id:studies?'Study':'Silo',puppeteerInstance:browser});
 if(stills||frameArg>=0){
  const times=frameArg>=0?args[frameArg+1].split(',').map(Number):[0,1.8,4.6,6.8,9.1,10.0,11.5,13.4,14.8,15.15,15.6,16.2,18.7,19.9,20.45,21.8,23.75,24.8,27.7,30.8,33.8];
  if(times.some(t=>!Number.isFinite(t)||t<0||t>=36))throw new Error('Review frames must be times between 0 and 36 seconds.');
  for(const t of times){await renderStill({composition,serveUrl,frame:Math.round(t*60),output:path.join(output,`frame-${t.toFixed(2)}.png`),puppeteerInstance:browser});console.log(`Frame ${t}s`);}
 }else{
  const variants=studies?[0,1,2]:[0];
  for(const variant of variants){
   let last=-1;const name=studies?`study-${variant+1}`:draft?'draft':'picture';
   const inputProps={variant,blur:!draft&&!studies};
   const resolved=await selectComposition({serveUrl,id:studies?'Study':'Silo',inputProps,puppeteerInstance:browser});
   await renderMedia({composition:resolved,serveUrl,codec:'h264',outputLocation:path.join(output,`${name}.mp4`),inputProps,puppeteerInstance:browser,scale:(draft||studies)?0.5:1,crf:draft||studies?22:17,concurrency:4,muted:true,onProgress:({progress})=>{const n=Math.floor(progress*10);if(n!==last){console.log(`${name}: ${n*10}%`);last=n;}}});
  }
  if(studies){const hashes=variants.map(v=>createHash('sha256').update(fs.readFileSync(path.join(output,`study-${v+1}.mp4`))).digest('hex'));if(new Set(hashes).size!==3)throw new Error('The three study exports must differ.');fs.writeFileSync(path.join(output,'study-hashes.json'),JSON.stringify(hashes,null,2)+'\n');}
 }
}finally{await browser.close({silent:true});}

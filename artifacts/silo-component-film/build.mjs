import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const root=path.dirname(fileURLToPath(import.meta.url));
const bundledPython='/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const python=process.env.SILO_VIDEO_PYTHON||(fs.existsSync(bundledPython)?bundledPython:'python3');
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});if(result.status!==0)throw new Error(`${command} failed (${result.status})`);}
fs.mkdirSync(path.join(root,'output'),{recursive:true});
if(!process.argv.includes('--mux-only')){
 run(python,['score.py']);
 run(process.execPath,['render.mjs']);
}
run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i','output/picture.mp4','-i','output/score-master.wav','-i','captions.vtt','-map','0:v:0','-map','1:a:0','-map','2:s:0','-c:v','copy','-c:a','aac','-b:a','256k','-ar','48000','-c:s','mov_text','-metadata:s:s:0','language=eng','-disposition:s:0','0','-metadata','title=Silo — Computers for your agents','-movflags','+faststart','output/silo-computers.mp4']);
run(python,['verify.py','output/silo-computers.mp4']);
const result=path.join(root,'output/silo-computers.mp4');
fs.writeFileSync(path.join(root,'output/final-sha256.txt'),`${createHash('sha256').update(fs.readFileSync(result)).digest('hex')}  silo-computers.mp4\n`);
console.log(`Finished: ${result}`);

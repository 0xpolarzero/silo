import {execFileSync,spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const out=join(here,'output');
const run=(bin,args,extra={})=>execFileSync(bin,args,{cwd:here,stdio:'inherit',...extra});
if(!process.argv.includes('--mux-only')){
 run(process.execPath,['render.mjs','--stills']);
 run(process.execPath,['render.mjs','--render']);
 run(process.env.SILO_VIDEO_PYTHON||'python3',['score.py']);
}
const final=join(out,'silo-computers-directed.mp4');
run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(out,'picture.mp4'),'-i',join(out,'score-master.wav'),'-i','captions.vtt','-map','0:v:0','-map','1:a:0','-map','2:0','-c:v','copy','-c:a','aac','-b:a','256k','-ar','48000','-c:s','mov_text','-disposition:s:0','0','-metadata:s:s:0','language=eng','-metadata:s:s:0','title=On-screen copy','-metadata','title=Silo / Computers for your agents','-metadata','comment=Original conceptual motion graphics and synthesized score. 128 BPM.','-t','33.75','-movflags','+faststart',final]);
const report=JSON.parse(run('ffprobe',['-v','error','-count_frames','-show_entries','stream=index,codec_name,codec_type,width,height,avg_frame_rate,nb_read_frames,duration,sample_rate,channels:format=duration,size','-of','json',final],{stdio:'pipe',encoding:'utf8'}));
const video=report.streams.find(s=>s.codec_type==='video');
if(video.width!==1920||video.height!==1080||video.nb_read_frames!=='2025'||video.avg_frame_rate!=='60/1'||Number(report.format.duration)!==33.75)throw Error('Unexpected final duration, dimensions, frame rate, or frame count.');
run('ffmpeg',['-hide_banner','-loglevel','error','-i',final,'-map','0:v:0','-map','0:a:0','-f','null','-']);
report.full_decode='passed';
writeFileSync(join(out,'directed-verification.json'),JSON.stringify(report,null,2)+'\n');
const audio=spawnSync('ffmpeg',['-hide_banner','-nostats','-i',final,'-vn','-af','loudnorm=I=-15:TP=-1.2:LRA=8:print_format=json','-f','null','-'],{cwd:here,encoding:'utf8'});
if(audio.status!==0)throw Error(audio.stderr);
const jsonStart=audio.stderr.lastIndexOf('{');
const stats=JSON.parse(audio.stderr.slice(jsonStart,audio.stderr.indexOf('}',jsonStart)+1));
writeFileSync(join(out,'directed-audio-verification.json'),JSON.stringify(stats,null,2)+'\n');
if(Number(stats.input_tp)>-.5)throw Error('Final audio true peak exceeds the delivery ceiling.');
console.log(`Final audio: ${stats.input_i} LUFS, ${stats.input_tp} dBTP.`);
console.log('Verified: 33.75 seconds, 1920 × 1080, 60 fps, 2025 frames, full audio/video decode.');
console.log(final);

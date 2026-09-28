import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(process.env.SILO_VIDEO_NODE_MODULES ? join(process.env.SILO_VIDEO_NODE_MODULES, 'package.json') : '/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'output');
await mkdir(OUT, {recursive:true});
GlobalFonts.registerFromPath('/System/Library/Fonts/SFNS.ttf', 'Film Sans');
GlobalFonts.registerFromPath('/System/Library/Fonts/SFNSMono.ttf', 'Film Mono');
const W=1920, H=1080, FPS=60, DURATION=54;
const canvas=createCanvas(W,H), c=canvas.getContext('2d');
const images=Object.fromEntries(await Promise.all(['overview','files','network','github','secrets','backup'].map(async name=>[name, await loadImage(join(HERE,'assets',name+'.png'))])));
const P={bg:'#0b0e10', panel:'#141c20', border:'#354045', white:'#f3eee4', gray:'#a0abae', dim:'#667578', amber:'#ffa62b', mint:'#b4d6c9', green:'#58cca1'};
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const mix=(a,b,t)=>a+(b-a)*t;
const ease=t=>1-Math.pow(1-clamp(t),5);
const smooth=t=>{t=clamp(t);return t*t*(3-2*t)};
const pop=(t,delay=0,d=.9)=>ease((t-delay)/d);
const rgba=(hex,a)=>{const v=parseInt(hex.slice(1),16);return `rgba(${v>>16},${v>>8&255},${v&255},${clamp(a)})`};
function group(fn,{x=0,y=0,s=1,alpha=1,rotate=0}={}) {c.save();c.globalAlpha*=clamp(alpha);c.translate(x,y);c.rotate(rotate);c.scale(s,s);fn();c.restore()}
function rect(x,y,w,h,r=0,fill=P.panel,stroke=null,lw=1){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=lw;c.stroke()}}
function line(x1,y1,x2,y2,color=P.border,width=1){c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.strokeStyle=color;c.lineWidth=width;c.stroke()}
function dot(x,y,r,color){c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fillStyle=color;c.fill()}
function text(str,x,y,size=40,color=P.white,weight=500,align='left',spacing=-.8,font='Film Sans'){c.font=`${Math.round(weight/100)*100} ${size}px "${font}"`;c.fillStyle=color;c.textAlign=align;c.textBaseline='alphabetic';c.letterSpacing=spacing+'px';c.fillText(str,x,y);c.letterSpacing='0px'}
function small(str,x,y,color=P.gray){text(str.toUpperCase(),x,y,19,color,500,'left',3,'Film Mono')}
function enterText(str,x,y,size,t,delay=0,color=P.white,weight=600){const e=pop(t,delay);c.save();c.beginPath();c.rect(x-5,y-size-8,1800,size+22);c.clip();group(()=>text(str,x,y,size,color,weight),{y:(1-e)*(size+18),alpha:e});c.restore()}
function chip(str,x,y,{color=P.mint,fill='#182622',size=24,pad=19}={}){c.font=`500 ${size}px "Film Sans"`;const w=c.measureText(str).width+pad*2;rect(x,y,w,46,23,fill,rgba(color,.2));text(str,x+pad,y+31,size,color,500,'left',-.2);return w}
function logo(x,y,size,t=1,spin=0){group(()=>{c.lineCap='round';[39,26,13].forEach((r,i)=>{const start=([-28,63,154][i]*Math.PI/180)+spin*(i%2?-1:1);c.beginPath();c.arc(0,0,r,start,start+[200/39,126/26,58/13][i]*clamp(t));c.strokeStyle=i===2?P.amber:P.white;c.lineWidth=7;c.stroke()})},{x,y,s:size/92})}
function icon(type,x,y,size=38,color=P.mint){group(()=>{c.lineWidth=2.3;c.lineCap='round';c.lineJoin='round';c.strokeStyle=color; if(type==='terminal'){line(-13,-8,-3,0,color,2.3);line(-3,0,-13,8,color,2.3);line(3,9,14,9,color,2.3)}else if(type==='code'){line(-6,-10,-16,0,color,2.3);line(-16,0,-6,10,color,2.3);line(6,-10,16,0,color,2.3);line(16,0,6,10,color,2.3)}else if(type==='monitor'){rect(-17,-12,34,24,4,null,color,2.3);line(0,12,0,19,color,2.3);line(-9,19,9,19,color,2.3)}else if(type==='lock'){rect(-12,-1,24,22,4,null,color,2.3);c.beginPath();c.arc(0,-3,8,Math.PI,0);c.stroke();dot(0,9,2.5,color)}else if(type==='server'){rect(-16,-15,32,12,3,null,color,2);rect(-16,3,32,12,3,null,color,2);dot(-9,-9,1.6,color);dot(-9,9,1.6,color)}else if(type==='check'){line(-9,0,-2,7,color,2.8);line(-2,7,12,-8,color,2.8)}else if(type==='folder'){c.beginPath();c.moveTo(-17,-10);c.lineTo(-3,-10);c.lineTo(2,-5);c.lineTo(17,-5);c.lineTo(17,14);c.lineTo(-17,14);c.closePath();c.stroke()}},{x,y,s:size/38})}
function shadow(fn,blur=55,alpha=.4){c.save();c.shadowColor=rgba('#000000',alpha);c.shadowBlur=blur;c.shadowOffsetY=20;fn();c.restore()}
// Source pixels are the current app's real React UI rendered with synthetic data.
function screen(name,x,y,w,{alpha=1,scale=1,rotation=0,crop=null}={}){const im=images[name],sx=crop?.[0]??35,sy=crop?.[1]??16,sw=crop?.[2]??1090,sh=crop?.[3]??708;const h=w*sh/sw;
 group(()=>{shadow(()=>rect(0,0,w,h,19,P.panel));c.save();c.beginPath();c.roundRect(0,0,w,h,19);c.clip();c.drawImage(im,sx*2,sy*2,sw*2,sh*2,0,0,w,h);c.restore();rect(0,0,w,h,19,null,'#3a484b',1.5)},{x,y,s:scale,alpha,rotate:rotation});return h}
function cursor(x,y,t=0,white=true){group(()=>{c.beginPath();c.moveTo(0,0);c.lineTo(0,30);c.lineTo(8,22);c.lineTo(15,37);c.lineTo(22,34);c.lineTo(15,19);c.lineTo(28,18);c.closePath();c.fillStyle=white?P.white:P.amber;c.fill();c.strokeStyle=P.bg;c.lineWidth=2;c.stroke();if(t>0){c.beginPath();c.arc(5,12,20+35*t,0,Math.PI*2);c.strokeStyle=rgba(P.amber,1-t);c.lineWidth=2;c.stroke()}},{x,y})}

const grain=createCanvas(W,H), gc=grain.getContext('2d'), id=gc.createImageData(W,H);let seed=941;
for(let i=0;i<id.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;const v=seed>>>24;id.data[i]=id.data[i+1]=id.data[i+2]=v;id.data[i+3]=8}gc.putImageData(id,0,0);
function background(t,light=false){c.fillStyle=light?P.white:P.bg;c.fillRect(0,0,W,H);if(light)return;
 let g=c.createRadialGradient(1410+Math.sin(t*.09)*180,540,0,1410,540,1130);g.addColorStop(0,'#1b292b');g.addColorStop(.6,'#10171a');g.addColorStop(1,P.bg);c.fillStyle=g;c.fillRect(0,0,W,H);
 c.save();c.globalAlpha=.12;for(let i=0;i<16;i++){const x=i*180-300+(t*5%180);line(x,0,x-340,H,'#425152',1)}c.restore();
 c.save();c.globalAlpha=.44;c.drawImage(grain,0,0);c.restore();
}
function furniture(label,t){logo(91,78,37);text('Silo',126,89,30,P.white,550);small(label,1480,84,P.dim);line(78,1003,1842,1003,'#283234');text('LINUX SANDBOXES / YOUR COMPUTERS',79,1040,15,P.dim,500,'left',1.6,'Film Mono');text('SILO',1842,1040,15,P.dim,500,'right',3,'Film Mono');}

function intro(t){
 const e=pop(t,.1,1.5);group(()=>{for(let i=0;i<6;i++){c.beginPath();c.arc(1450,520,190+i*64,0,Math.PI*2);c.strokeStyle=rgba(P.mint,.022+i*.006);c.lineWidth=1;c.stroke()}
 logo(1450,520,620,e,(1-e)*2.7+.04*Math.sin(t));dot(1450,520,4,P.amber);
 [0,1,2].forEach(i=>{const a=t*.18+i*2.1;dot(1450+392*Math.cos(a),520+392*Math.sin(a),3,P.mint)})},{alpha:e});
 small('A new space for your work',116,263,P.mint);
 enterText('More room',110,425,126,t,.12);enterText('to build.',110,568,126,t,.32,P.amber);
 group(()=>{text('Linux sandboxes.',117,682,33,P.gray,400);text('On your computers.',117,728,33,P.gray,400)},{alpha:pop(t,1,1),y:24*(1-pop(t,1,1))});
 group(()=>{line(118,863,198,863,P.amber,2);small('Meet Silo',222,870,P.white)},{alpha:pop(t,2.6)});
}
function reveal(t){furniture('01 / A PLACE TO BUILD',t);const e=pop(t,0,1.5);
 group(()=>{logo(276,464,187,1);enterText('Silo.',111,680,151,t,.2);text('Your next idea starts here.',117,753,31,P.gray,400)},{alpha:e,x:-30*(1-e)});
 const sc=1.01+.012*Math.sin(t*.6);screen('overview',668-(1-e)*150,228+(1-e)*155,1120,{rotation:mix(-.06,-.016,e),scale:sc});
 group(()=>{chip('Real Linux virtual machines',873,899,{color:P.mint});},{alpha:pop(t,1.2),y:20*(1-pop(t,1.2))});
}
function machines(t){furniture('02 / ACROSS COMPUTERS',t);
 enterText('Your machines.',112,253,88,t);enterText('One home.',112,352,88,t,.13,P.amber);
 group(()=>{text('Manage local and remote sandboxes together.',118,413,30,P.gray,400)},{alpha:pop(t,.45)});
 const e=pop(t,.25,1.2);screen('overview',115,482+65*(1-e),1302,{alpha:e,crop:[35,16,1090,362]});
 group(()=>{rect(1462,501,344,168,20,'#172225',P.border);icon('monitor',1505,553,34);text('This computer',1540,564,26,P.white,550);dot(1508,616,5,P.green);text('2 sandboxes',1528,625,24,P.gray,400);
 rect(1462,729,344,168,20,'#172225',P.border);icon('server',1505,781,34);text('Studio Linux',1540,792,26,P.white,550);dot(1508,844,5,P.green);text('Connected over SSH',1528,853,22,P.gray,400);
 line(1634,670,1634,728,P.mint,1.5);const p=((t*.6)%1);dot(1634,mix(675,724,p),4,P.amber);
 },{alpha:pop(t,1.3),x:40*(1-pop(t,1.3))});
 const p=pop(t,2.6);group(()=>{rect(316,771,435,59,13,'#111b1a',rgba(P.mint,.4));icon('check',349,798,25);text('Local. Remote. In one app.',375,808,25,P.mint,500)},{alpha:p,y:15*(1-p)});
}
function tools(t){furniture('03 / YOUR WORKFLOW',t);
 enterText('Same tools.',112,251,89,t);enterText('New boundaries.',112,351,89,t,.14,P.amber);
 group(()=>text('Your editor. Your terminal. Your development servers.',118,416,29,P.gray,400),{alpha:pop(t,.45)});
 const e=pop(t,.1);const page=t<3.4?'files':'network';
 const sw=smooth((t-3.3)/.4); screen('files',820,205+50*(1-e),1010,{alpha:e*(1-sw),rotation:-.012,crop:[35,16,1090,690]}); if(sw>0)screen('network',820,205,1010,{alpha:e*sw,rotation:-.012,crop:[35,16,1090,690]});
 const items=[['code','Open in your editor','/workspace/projects'],['terminal','Open a terminal','A full Linux environment'],['monitor','Connect a local port','127.0.0.1:3000']];
 items.forEach(([ic,a,b],i)=>{const p=pop(t,.7+i*.7);group(()=>{rect(117,509+i*136,620,111,17,'#172125',i===(t>3.4?2:0)?rgba(P.amber,.65):P.border);icon(ic,164,561+i*136,39,i===(t>3.4?2:0)?P.amber:P.mint);text(a,210,554+i*136,28,P.white,550);text(b,210,590+i*136,21,P.gray,400,'left',0,'Film Mono')},{alpha:p,x:-35*(1-p)});});
 group(()=>{chip('Inside the sandbox. In your flow.',875,903,{color:P.mint,size:24})},{alpha:pop(t,2.9)});
}
function desktop(t){furniture('04 / AGENT COMPUTER USE',t);
 enterText('Give your agents',112,242,82,t);enterText('a desktop.',112,338,82,t,.12,P.amber);
 group(()=>{text('Let them see, click, and work',118,422,29,P.gray,400);text('inside their own Linux environment.',118,463,29,P.gray,400);small('Powered by Luda',118,536,P.mint)},{alpha:pop(t,.6)});
 const e=pop(t,.2,1.3);group(()=>{
 shadow(()=>rect(0,0,1050,654,18,'#223b3e'));c.save();c.beginPath();c.roundRect(0,0,1050,654,18);c.clip();
 const g=c.createLinearGradient(0,0,1050,654);g.addColorStop(0,'#314e51');g.addColorStop(1,'#162527');c.fillStyle=g;c.fillRect(0,0,1050,654);
 for(let i=0;i<5;i++){c.beginPath();c.ellipse(790,445,350+i*80,200+i*50,-.6,0,Math.PI*2);c.strokeStyle=rgba(P.mint,.05);c.lineWidth=1;c.stroke()}
 rect(0,0,1050,44,0,'#101619');icon('monitor',24,23,21);text('dev · Linux desktop',47,29,18,P.white,500);text('•••',1019,28,23,P.gray,500,'right');
 rect(0,44,1050,29,0,'#29383a');text('Applications',15,65,13,P.mint,400);text('09:41',1025,64,13,P.gray,400,'right');
 // Deliberately illustrated application content, not a claim of live agent execution.
 const bp=pop(t,1.25,1.1);group(()=>{shadow(()=>rect(290,113,702,445,9,'#eeeae0'),28);rect(290,113,702,35,8,'#263132');text('Workspace · Mozilla Firefox',308,137,14,P.white,400);rect(290,148,702,43,0,'#d7dbd5');rect(375,157,570,24,5,'#f5f4ef');text('localhost:3000',390,174,14,'#50615d',400);small('FIELDNOTES / PROJECTS',515,243,'#658075');text('Make something',515,308,39,'#173c32',600);text('worth opening.',515,355,39,'#173c32',600);text('A fresh space for your next idea.',515,401,18,'#687a70',400);
 const clicked=t>5.45;rect(515,429,206,49,8,clicked?'#c0d1bd':'#274e3d');text(clicked?'Project created':'Create a project',532,460,19,clicked?'#294b3a':'#f5f4e8',550);if(clicked){icon('check',757,452,30,'#375f45');rect(515,500,428,27,6,'#dce4d6');text('Untitled project',531,519,15,'#476649',500)}
 },{alpha:bp,x:40*(1-bp)});
 const tp=pop(t,.55,1);group(()=>{shadow(()=>rect(35,259,450,326,12,'#10191d'),30);rect(35,259,450,37,12,'#273134');text('Agent terminal',53,283,16,P.white,500);dot(455,278,4,P.gray);
 text('› Test the project creation flow.',57,337,17,P.white,400,'left',-.2,'Film Mono');
 const rows=[['Observe the desktop',2.1],['Open localhost:3000',3.2],['Click “Create a project”',5.5],['Verify the new project',6.7]];
 rows.forEach(([s,delay],i)=>{const p=pop(t,delay,.3);group(()=>{icon('check',64,384+i*42,17,P.green);text(s,84,390+i*42,15,P.mint,400,'left',-.2,'Film Mono')},{alpha:p})});
 if(t>7.4){chip('Flow verified',56,541,{size:16,pad:15,color:P.green})}
 },{alpha:tp,x:-40*(1-tp)});
 if(t>3.7&&t<6.7){const p=smooth((t-3.7)/1.6);cursor(mix(887,665,p),mix(377,454,p),t>5.3&&t<5.8?(t-5.3)*2:0)}
 c.restore();rect(0,0,1050,654,18,null,'#557074',1.5);
 },{x:766+50*(1-e),y:210+40*(1-e),s:1,alpha:e,rotate:-.007});
 const names=['Codex','Claude Code','Cursor'];let x=118;names.forEach((name,i)=>{group(()=>chip(name,x,697,{size:24,fill:'#192220',color:P.mint}),{alpha:pop(t,2+i*.2)});x+=name.length*13+64});
 group(()=>{text('Optional desktop. Install and sign in to your agent.',118,813,22,P.gray,400);small('Illustrative agent workflow',118,922,P.dim)},{alpha:pop(t,2.8)});
}
function permissions(t){furniture('05 / DELIBERATE ACCESS',t);
 enterText('You choose',112,248,91,t);enterText('what gets in.',112,352,91,t,.12,P.amber);
 group(()=>text('Set the boundaries for each sandbox.',118,416,30,P.gray,400),{alpha:pop(t,.5)});
 const e=pop(t,.2,1.15);screen('github',847,192+65*(1-e),968,{alpha:e,rotation:.008,crop:[35,16,1090,708]});
 const cards=[['Selected repositories','Give each sandbox the GitHub access it needs.'],['Read-only by default','Allow changes when you choose.'],['Scoped credentials','Choose the sandbox and the HTTPS domain.']];
 cards.forEach(([a,b],i)=>{const p=pop(t,.75+i*.9);group(()=>{line(118,508+i*126,728,508+i*126,P.border);icon(i===2?'lock':'check',142,553+i*126,29,i===2?P.amber:P.mint);text(a,181,550+i*126,29,P.white,550);text(b,181,590+i*126,23,P.gray,400)},{alpha:p,y:22*(1-p)})});
 const q=pop(t,4.1,1);group(()=>{shadow(()=>rect(1025,703,712,209,21,'#1a2527',rgba(P.amber,.55)),35);icon('lock',1080,754,35,P.amber);text('API_KEY',1118,764,27,P.white,550,'left',.6,'Film Mono');text('••••••••••••••••',1063,822,31,P.gray,500,'left',4);chip('dev',1061,847,{size:19,fill:'#293330',color:P.mint});chip('api.example.com',1160,847,{size:19,fill:'#293330',color:P.mint});},{alpha:q,y:55*(1-q),rotate:0});
}
function backup(t){furniture('06 / ROOM TO EXPERIMENT',t);
 enterText('Try it.',112,264,105,t);enterText('Keep a way back.',112,380,83,t,.14,P.amber);
 group(()=>{text('Export local sandbox disks.',119,454,30,P.gray,400);text('Restore backups as new sandboxes.',119,499,30,P.gray,400)},{alpha:pop(t,.55)});
 const e=pop(t,.2,1.3);group(()=>{for(let i=3;i>0;i--){const o=pop(t,.3+i*.15);rect(846+i*28,547-i*54,862,412,21,rgba('#253338',.8),rgba(P.mint,.14*o))}
 screen('backup',888,286,901,{crop:[35,16,1090,652]});},{alpha:e,y:65*(1-e)});
 group(()=>{rect(116,648,565,159,20,'#192324',P.border);icon('folder',163,698,42,P.mint);text('Your work, preserved.',204,707,31,P.white,550);text('.silo-backup',148,769,25,P.amber,450,'left',1,'Film Mono');},{alpha:pop(t,1.45),y:35*(1-pop(t,1.45))});
}
function manifesto(t){
 const n=Math.min(2,Math.floor(t));const light=n===1;background(t,light);const color=light?P.bg:P.white;const words=['Your computers.','Your tools.','Your rules.'];
 const e=pop(t-n,0,.6);group(()=>{text(words[n],960,591,150,n===2?P.amber:color,650,'center',-5);},{s:mix(1.09,1,e),x:960*(1-mix(1.09,1,e)),y:540*(1-mix(1.09,1,e)),alpha:pop(t-n,0,.17)});
 small('SILO',115,111,light?'#657171':P.dim);text(`0${n+1}`,1806,982,23,light?'#657171':P.dim,450,'right',1,'Film Mono');
}
function outro(t){const e=pop(t,.1,1.4);
 for(let i=0;i<7;i++){c.beginPath();c.arc(960,397,172+i*75,0,Math.PI*2);c.strokeStyle=rgba(P.mint,.05-i*.004);c.lineWidth=1;c.stroke()}
 group(()=>{logo(758,396,192,1,(1-e)*1.5);text('Silo',902,457,167,P.white,550,'left',-6)},{alpha:e,y:30*(1-e)});
 group(()=>{text('Space to build.',960,610,67,P.white,500,'center',-1.5);text('Linux sandboxes. On your computers.',960,677,31,P.gray,400,'center',-.3)},{alpha:pop(t,.65),y:24*(1-pop(t,.65))});
 group(()=>{rect(686,759,548,77,38,P.amber);text('silo.polarzero.xyz',960,810,31,P.bg,600,'center',-.2);text('macOS  /  Linux',960,896,24,P.mint,450,'center',.5)},{alpha:pop(t,1.5),y:18*(1-pop(t,1.5))});
 small('RUN ON YOUR OWN HARDWARE',752,1001,P.dim);
}
const scenes=[{at:0,fn:intro},{at:4.5,fn:reveal},{at:8.5,fn:machines},{at:15,fn:tools},{at:22,fn:desktop},{at:31,fn:permissions},{at:39,fn:backup},{at:45,fn:manifesto},{at:48,fn:outro}];
function draw(t){c.resetTransform();c.globalAlpha=1;c.clearRect(0,0,W,H);background(t);let i=scenes.findLastIndex(s=>s.at<=t);const scene=scenes[i], local=t-scene.at;
 if(i>0&&local<.7&&i!==7){const e=smooth(local/.7);
   group(()=>scenes[i-1].fn(scene.at-scenes[i-1].at),{x:-60*e,alpha:1-.3*e});
   c.save();c.beginPath();
   if(i===1||i===8){c.arc(i===1?1450:960,i===1?520:540,2300*e,0,Math.PI*2)}
   else {const edge=1920*(1-e);c.moveTo(edge+170,0);c.lineTo(1920,0);c.lineTo(1920,1080);c.lineTo(edge-170,1080);c.closePath()}
   c.clip();background(t);group(()=>scene.fn(local),{x:30*(1-e)});c.restore();
 }else scene.fn(local);
 if(t<.45){c.fillStyle=rgba(P.bg,1-smooth(t/.45));c.fillRect(0,0,W,H)}
 // Hold the end card; only the soundtrack fades out.
}

if(process.argv.includes('--stills')){
 const times=[1.8,6.7,12.5,19.8,29.5,36.8,42.8,46.4,51.5];
 for(const [i,t] of times.entries()){draw(t);await writeFile(join(OUT,`shot-${String(i+1).padStart(2,'0')}.png`),canvas.toBuffer('image/png'))}
 const board=createCanvas(1440,810), b=board.getContext('2d');
 for(const [i,t] of times.entries()){draw(t);b.drawImage(canvas,(i%3)*480,Math.floor(i/3)*270,480,270)}
 await writeFile(join(OUT,'storyboard.jpg'),board.toBuffer('image/jpeg',94));console.log('Wrote nine storyboard frames.');
} else if(process.argv.includes('--render')) {
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',join(OUT,'picture.mp4')],{stdio:['pipe','inherit','inherit']});
 ff.stdin.on('error',e=>{throw e});
 for(let frame=0;frame<DURATION*FPS;frame++){draw(frame/FPS);if(!ff.stdin.write(canvas.data()))await once(ff.stdin,'drain');if(frame%(FPS*3)===0)console.log(`Rendered ${(frame/FPS).toFixed(0)} / ${DURATION}s`)}
 ff.stdin.end();const [code]=await once(ff,'close');if(code!==0)throw Error(`ffmpeg exited ${code}`);console.log('Picture complete.');
} else if(process.argv.includes('--frame')) {const t=Number(process.argv[process.argv.indexOf('--frame')+1]);draw(t);await writeFile(join(OUT,'frame.png'),canvas.toBuffer('image/png'))}

export {draw,DURATION,FPS};

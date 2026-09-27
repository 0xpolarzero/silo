import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(process.env.SILO_VIDEO_NODE_MODULES||'/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules','package.json'));
const {createCanvas,GlobalFonts,Path2D,loadImage}=require('@napi-rs/canvas');
GlobalFonts.registerFromPath('/System/Library/Fonts/Avenir Next Condensed.ttc','Display');
GlobalFonts.registerFromPath('/System/Library/Fonts/SFNS.ttf','Sans');
GlobalFonts.registerFromPath('/System/Library/Fonts/SFNSMono.ttf','Mono');
const W=1920,H=1080,FPS=60,DURATION=33.75,B=60/128,BAR=4*B;
const out=join(here,'output');await mkdir(out,{recursive:true});
const cv=createCanvas(W,H),ctx=cv.getContext('2d');let c=ctx;
const p={paper:'#eeeadd',ink:'#191a17',orange:'#ff582d',amber:'#ff9f0a',white:'#fffdf3',muted:'#797a70'};
const TAU=Math.PI*2,clamp=x=>Math.max(0,Math.min(1,x)),lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>1-Math.pow(1-clamp(t),4),smooth=t=>{t=clamp(t);return t*t*(3-2*t)},io=t=>{t=clamp(t);return t<.5?8*t**4:1-(-2*t+2)**4/2};
const spring=t=>1-Math.exp(-9*Math.max(t,0))*Math.cos(14*Math.max(t,0));
function col(hex,a=1){const v=parseInt(hex.slice(1),16);return `rgba(${v>>16},${v>>8&255},${v&255},${clamp(a)})`}
function g(fn,{x=0,y=0,sx=1,sy=sx,a=1,r=0}={}){c.save();c.translate(x,y);c.rotate(r);c.scale(sx,sy);c.globalAlpha*=clamp(a);fn();c.restore()}
function rect(x,y,w,h,fill,r=0,stroke=null,lw=1){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=lw;c.stroke()}}
function line(x,y,x2,y2,color,width=1){c.beginPath();c.moveTo(x,y);c.lineTo(x2,y2);c.strokeStyle=color;c.lineWidth=width;c.stroke()}
function circle(x,y,r,fill,stroke=null,lw=1){if(r<0)return;c.beginPath();c.arc(x,y,r,0,TAU);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.lineWidth=lw;c.strokeStyle=stroke;c.stroke()}}
function text(str,x,y,size=30,color=p.ink,{font='Sans',weight=500,align='left',tracking=0,width,stroke=false}={}){
 c.save();c.font=`${Math.round(weight/100)*100} ${size}px "${font}"`;c.textBaseline='alphabetic';c.textAlign=align;c.letterSpacing=tracking+'px';
 if(width){const actual=c.measureText(str).width;c.translate(x,y);c.scale(width/actual,1);x=0;y=0}
 if(stroke){c.strokeStyle=color;c.lineWidth=1.5;c.strokeText(str,x,y)}else{c.fillStyle=color;c.fillText(str,x,y)}c.restore();
}
function display(str,x,y,size,color=p.ink,width,opts={}){text(str,x,y,size,color,{font:'Display',weight:900,tracking:-2,width,...opts})}
function label(str,x,y,color=p.ink,align='left'){text(str,x,y,20,color,{font:'Mono',weight:500,tracking:2,align})}
function tick(x,y,color=p.ink){line(x-8,y,x+8,y,color,1);line(x,y-8,x,y+8,color,1)}
function rule(y,color=p.ink){line(76,y,W-76,y,col(color,.32),1)}
function bg(color){c.fillStyle=color;c.fillRect(0,0,W,H)}
function clipBox(x,y,w,h,fn){c.save();c.beginPath();c.rect(x,y,w,h);c.clip();fn();c.restore()}
function brandMark(x,y,size,t=1,spin=0,color=p.ink,inner=p.orange){g(()=>{c.lineCap='round';[39,26,13].forEach((r,i)=>{const start=[-28,63,154][i]*Math.PI/180+spin*(i%2?-1:1);c.beginPath();c.arc(0,0,r,start,start+[200/39,126/26,58/13][i]*clamp(t));c.lineWidth=7;c.strokeStyle=i===2?inner:color;c.stroke()})},{x,y,sx:size/92})}

// Orthogonal rotation and perspective, shared by the machine, network, and mark.
function rotate(v,rx,ry,rz=0){let [x,y,z]=v;let a=y*Math.cos(rx)-z*Math.sin(rx),b=y*Math.sin(rx)+z*Math.cos(rx);y=a;z=b;a=x*Math.cos(ry)+z*Math.sin(ry);b=-x*Math.sin(ry)+z*Math.cos(ry);x=a;z=b;return[x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz),z]}
function project(v,opts={}){const {cx=960,cy=560,cam=1400,scale=1}=opts;const k=cam/(cam+v[2]);return[cx+v[0]*k*scale,cy+v[1]*k*scale,v[2]]}
const vertices=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const faces=[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[4,5,1,0],[3,2,6,7]];
function cubeFaces(center,size,rx,ry,rz,opts={},palette){
 const points=vertices.map(v=>{let q=v.map(n=>n*size/2);if(opts.localRotation)q=rotate(q,...opts.localRotation);return rotate(q.map((n,i)=>n+center[i]),rx,ry,rz)});
 const shades=palette||['#ff633b','#dc3816','#a9270c','#f74920','#ffac78','#b42d11'];
 return faces.map((ids,i)=>({z:ids.reduce((s,j)=>s+points[j][2],0)/4,pts:ids.map(j=>project(points[j],opts)),fill:shades[i],stroke:opts.stroke??col(p.ink,.7),lw:opts.lw??1.6}));
}
function polygons(all){all.sort((a,b)=>b.z-a.z).forEach(f=>{c.beginPath();f.pts.forEach((pt,i)=>i?c.lineTo(pt[0],pt[1]):c.moveTo(pt[0],pt[1]));c.closePath();c.fillStyle=f.fill;c.fill();if(f.stroke){c.strokeStyle=f.stroke;c.lineWidth=f.lw||1;c.stroke()}})}
function wireCube(center,size,rx,ry,rz,opts={},color=p.ink,width=1.2){const pts=vertices.map(v=>project(rotate(v.map((n,i)=>n*size/2+center[i]),rx,ry,rz),opts));[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]].forEach(([a,b])=>line(pts[a][0],pts[a][1],pts[b][0],pts[b][1],color,width))}
function ground(t,color=p.ink){g(()=>{for(let i=-9;i<=9;i++){line(960+i*90,675,960+i*400,1250,col(color,.12),1)}for(let j=0;j<7;j++){const y=675+((j*63+t*18)%450)**1.04;line(0,y,W,y,col(color,.12),1)}},{a:.65})}
function shadowEllipse(x,y,rx,ry,a=.12){const grad=c.createRadialGradient(x,y,0,x,y,rx);grad.addColorStop(0,col(p.ink,a));grad.addColorStop(1,col(p.ink,0));g(()=>{circle(0,0,rx,grad)},{x,y,sx:1,sy:ry/rx})}

function pointer(x,y,s=1,r=0,color=p.ink){g(()=>{c.beginPath();c.moveTo(0,0);c.lineTo(4,172);c.lineTo(47,128);c.lineTo(81,202);c.lineTo(119,184);c.lineTo(83,116);c.lineTo(143,107);c.closePath();c.fillStyle=color;c.fill();c.lineWidth=5;c.strokeStyle=p.paper;c.stroke()},{x,y,sx:s,r})}
function ringMesh(t,x,y,size,flatten=0){const dots=[],rx=lerp(-.7,0,flatten),ry=lerp(t*.66,0,flatten);for(let ring=0;ring<3;ring++){
 const R=[39*600/92,26*600/92,13*600/92][ring],start=[-28,63,154][ring]*Math.PI/180,span=[200/39,126/26,58/13][ring];
 for(let i=0;i<110;i++){const a=start+span*i/109;for(let j=0;j<4;j++){const r=R+(j-1.5)*14.2;const v=rotate([Math.cos(a)*r,Math.sin(a)*r,Math.sin((a+t)*3)*22*(1-flatten)],rx,ry);dots.push({pt:project(v,{cx:x,cy:y,scale:size/600,cam:1700}),ring})}}
 }
 dots.sort((a,b)=>b.pt[2]-a.pt[2]);dots.forEach(({pt,ring})=>circle(pt[0],pt[1],5*size/600,ring===2?p.orange:p.paper));
}

// All interface scenes are purpose-built illustrations of documented features.

function arrow(x,y,x2,y2,color=p.ink,width=3){
 line(x,y,x2,y2,color,width);const a=Math.atan2(y2-y,x2-x);
 line(x2,y2,x2-17*Math.cos(a-.5),y2-17*Math.sin(a-.5),color,width);
 line(x2,y2,x2-17*Math.cos(a+.5),y2-17*Math.sin(a+.5),color,width);
}
function check(x,y,size=18,color=p.ink){line(x-size*.5,y,x-size*.1,y+size*.4,color,4);line(x-size*.1,y+size*.4,x+size*.65,y-size*.5,color,4)}
function typeLine(str,x,y,size,t,color=p.paper){text(str.slice(0,Math.floor(clamp(t)*str.length)),x,y,size,color,{font:'Mono',weight:500});}
function header(index,title,color=p.ink){label(index+' / '+title,80,91,color);brandMark(1816,79,52,1,0,color,p.orange);}

function opening(t){
 const final=ease((t-1.875)/.55);
 if(t<1.875){
  const step=t<2*B?0:t<3*B?1:2,u=t-[0,2*B,3*B][step];
  bg([p.paper,p.orange,p.ink][step]);
  const words=['COMPUTERS','FOR YOUR','AGENTS.'],sizes=[367,429,570],y=[703,733,790];
  const q=ease(u/.29);
  g(()=>display(words[step],77,y[step],sizes[step],step===2?p.paper:p.ink,1766),{sx:lerp(1.16,1,q),sy:lerp(.7,1,q),x:960*(1-lerp(1.16,1,q)),y:130*(1-q)});
  if(step===0){rect(81,767,1757*ease(t/.65),25,p.orange);brandMark(108,111,60);label('SILO',164,119);label('LINUX VMs',1835,977,p.ink,'right')}
  if(step===1){label('ON YOUR COMPUTERS',83,114);label('MACOS + LINUX',1835,984,p.ink,'right')}
  return;
 }
 bg(p.paper);header('SILO','COMPUTERS FOR YOUR AGENTS');
 clipBox(55,180,1210,660,()=>g(()=>{
  display('COMPUTERS',80,416,230,p.ink,1100);
  display('FOR YOUR',80,622,230,p.ink,1030);
  display('AGENTS.',80,829,230,p.ink,898);
 },{y:120*(1-final)}));
 const u=t-1.875,rx=-.49-u*.12,ry=.64+u*.38;
 const cam={cx:1480,cy:547,scale:1.04*spring(u/.6),cam:1700};
 shadowEllipse(1460,865,370,55,.13);
 const explode=smooth((u-.55)/.95)*38,fs=[];
 for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)fs.push(...cubeFaces([x*(95+explode),y*(95+explode),z*(95+explode)],90,rx,ry,.08,cam));
 polygons(fs);wireCube([0,0,0],490,rx,ry,.08,cam,col(p.ink,.28));
 rule(907);g(()=>text('Run Linux VMs locally or remotely.',81,976,44,p.ink,{weight:500}),{a:ease((u-.15)/.4)});
 label('FILES / TOOLS / PROCESSES',1836,979,p.ink,'right');
}

// A single scene graph: host, VM, controlling laptop, then a persistent workspace.
// UI views are illustrative; scope setup happens on the hosting computer.
function mixColor(a,b,t){const A=parseInt(a.slice(1),16),B=parseInt(b.slice(1),16);return '#'+[16,8,0].map(s=>Math.round(lerp(A>>s&255,B>>s&255,t)).toString(16).padStart(2,'0')).join('')}
const move=(t,start,duration=.55)=>io((t-start)/duration);
function panel(x,y,w,h,fill=p.white,r=12,stroke=col(p.ink,.12)){rect(x,y,w,h,fill,r,stroke,1.2)}
function depthPanel(x,y,w,h,fill=p.white,r=16){c.save();c.shadowColor=col(p.ink,.13);c.shadowBlur=42;c.shadowOffsetY=19;rect(x,y,w,h,fill,r);c.restore();rect(x,y,w,h,null,r,col(p.ink,.2),1.3)}
function capsule(str,x,y,w,fill=p.ink,color=p.paper,size=19){rect(x,y,w,36,fill,18);text(str,x+w/2,y+25,size,color,{font:'Mono',align:'center',weight:500})}
function micro(str,x,y,color=p.muted,align='left'){text(str,x,y,18,color,{font:'Mono',tracking:1.2,align})}
function smallCursor(x,y,alpha=1,press=0,color=p.orange){g(()=>pointer(0,0,.24*(1-press*.1),0,color),{x,y,a:alpha})}
function clickMark(x,y,u){if(u<0||u>.3)return;circle(x,y,8+30*ease(u/.3),null,col(p.orange,(1-u/.3)*.65),2)}
function cursorTravel(t,start,end,from,to,hold=.2){if(t<start||t>end+hold+.18)return;const u=move(t,start,end-start),a=Math.min(ease((t-start)/.12),1-ease((t-end-hold)/.18));const x=lerp(from[0],to[0],u),y=lerp(from[1],to[1],u);smallCursor(x,y,a,Math.sin(Math.PI*clamp((t-end)/.12)));clickMark(to[0],to[1],t-end)}
function folderIcon(x,y,color=p.orange){rect(x,y,21,9,color,3);rect(x,y+6,35,23,color,3)}
function keyIcon(x,y,color=p.orange){circle(x,y,8,null,color,3);line(x+7,y,x+31,y,color,3);line(x+23,y,x+23,y+7,color,3);line(x+30,y,x+30,y+5,color,3)}
function monitorIcon(x,y,color=p.paper){rect(x,y,37,24,null,3,color,2);line(x+18,y+24,x+18,y+32,color,2);line(x+9,y+32,x+28,y+32,color,2)}
function processDot(x,y,t,on){circle(x,y,5,on?p.orange:p.muted);if(on)circle(x,y,10+7*((t*.8)%1),null,col(p.orange,.22*(1-(t*.8)%1)),1.5)}
function scopeCard(x,y,w,h,which,t,collapse){
 const on=which===0?t>.62:t>1.82;
 panel(x,y,w,h,p.white,lerp(12,5,collapse));
 const a=1-smooth((collapse-.12)/.3);
 g(()=>{
  if(which===0){folderIcon(x+28,y+28);micro('GITHUB REPOSITORY · OAUTH',x+85,y+47);text('your-app',x+29,y+135,58,p.ink,{weight:650});capsule('READ ONLY',x+w-218,y+99,178,on?p.orange:p.paper,p.ink,18);}
  else{keyIcon(x+43,y+41);micro('API CREDENTIAL · ALLOWED HTTPS DOMAIN',x+85,y+47);text('api.example.com',x+29,y+135,47,p.ink,{font:'Mono'});capsule('SCOPED',x+w-178,y+99,138,on?p.orange:p.paper,p.ink,18);}
 },{a});
 g(()=>{text(which===0?'REPO':'API',x+w/2,y+h/2+6,17,p.ink,{font:'Mono',align:'center'});},{a:smooth((collapse-.6)/.4)});
}
function hostMachine(t,zoom,dark){
 const x=lerp(1470,1560,zoom),y=lerp(405,426,zoom),w=lerp(302,235,zoom),h=lerp(490,465,zoom);
 const run=t>=4.9,ink=mixColor(p.ink,p.paper,dark);
 text('Office computer',x+w/2+12,y-57,29,ink,{align:'center',weight:600});micro('HOSTING THE VM',x+w/2+12,y-26,mixColor(p.muted,'#a5a69a',dark),'center');
 c.beginPath();c.moveTo(x,y);c.lineTo(x+31,y-25);c.lineTo(x+w+31,y-25);c.lineTo(x+w,y);c.closePath();c.fillStyle='#56584d';c.fill();
 c.beginPath();c.moveTo(x+w,y);c.lineTo(x+w+31,y-25);c.lineTo(x+w+31,y+h-25);c.lineTo(x+w,y+h);c.closePath();c.fillStyle='#34362f';c.fill();
 panel(x,y,w,h,'#24261f',8,col(p.paper,.15));
 micro('SILO',x+23,y+39,p.paper);processDot(x+w-24,y+32,t,run);
 const vx=x+20,vy=y+74,vw=w-40;
 panel(vx,vy,vw,282,p.ink,5,col(p.paper,.2));
 text('your-app',vx+19,vy+39,29,p.paper,{weight:650});micro('LINUX VM',vx+20,vy+67,'#9d9f92');
 const q=ease((t-4.9)/.3),shades=['#ff633b','#dc3816','#a9270c','#f74920','#ffac78','#b42d11'].map(s=>mixColor('#686b5d',s,q));
 polygons(cubeFaces([0,0,0],104,-.5,.65+.05*Math.sin(t*.6),.06,{cx:vx+vw/2,cy:vy+154,cam:1800,stroke:col(p.ink,.1),lw:1},shades));
 if(t>=10.1){capsule(':3000',vx+vw/2-55,vy+225,110,p.orange,p.ink,22)}else{text(run?'Running':'Ready',vx+vw/2,vy+252,22,run?p.orange:'#a5a69a',{align:'center',weight:550})}
 if(t>=3.5){capsule('REPO',x+24,y+382,(w-61)/2,p.paper,p.ink,15);capsule('API',x+37+(w-61)/2,y+382,(w-61)/2,p.paper,p.ink,15);}
 for(let i=0;i<8;i++)line(x+26+i*15,y+h-29,x+26+i*15,y+h-15,col(p.paper,.25),2);
 return {x,y,w,h,vmx:vx+vw/2,vmy:vy+154};
}
function stageTitle(t,dark){
 const titles=[['Choose what it can access.',0],['Start it here. Run it there.',3.75],['Connect over SSH.',7.5],['From server to browser.',11.25],['Give agents a desktop.',16.875]];
 const ink=mixColor(p.ink,p.paper,dark);
 micro('SILO / COMPUTERS FOR YOUR AGENTS',80,83,ink);brandMark(1827,73,52,1,0,ink,p.orange);
 clipBox(60,137,1800,162,()=>{for(let i=0;i<titles.length;i++){
  const [str,start]=titles[i],next=titles[i+1]?.[1]??100;
  if(t<start-.3||t>next+.3)continue;
  const incoming=start===0?ease((t+.05)/.45):ease((t-start)/.38);
  const outgoing=ease((t-(next-.26))/.26);
  const widths=[1670,1738,1240,1636,1565];
  g(()=>display(str.toUpperCase(),79,269,164,ink,widths[i]),{y:48*(1-incoming)-55*outgoing,a:incoming*(1-outgoing)});
 }});
}
function projectBar(t,desktop){
 text('your-app',26,166,43,p.ink,{weight:650,tracking:-1.3});
 g(()=>{micro('LINUX VM · OFFICE COMPUTER',28,193,p.muted);},{a:1-desktop});
 g(()=>{micro('LINUX DESKTOP · OFFICE COMPUTER',28,193,p.muted);},{a:desktop});
 processDot(975,153,t,t>=4.9);text(t>=4.9?'Running':'Ready',994,162,24,p.ink,{weight:550});
}
function workspaceChrome(t){
 const d=move(t,16.875,.55);
 panel(0,0,1200,630,mixColor(p.paper,'#d6d5c7',d),13,col(p.ink,.18));
 c.save();c.beginPath();c.roundRect(0,0,1200,630,13);c.clip();
 rect(0,0,1200,61,p.ink);
 const external=ease((t-7.5)/.35)*(1-ease((t-16.875)/.35));
 g(()=>{brandMark(29,31,32,1,0,p.paper,p.orange);text('Silo',60,41,28,p.paper,{weight:600});text('YOUR LAPTOP',119,40,15,'#b6b8ac',{font:'Mono',tracking:1.4});},{a:1-external});
 g(()=>{monitorIcon(19,14,p.paper);text('Your laptop',75,41,28,p.paper,{weight:600});text('YOUR TOOLS',242,40,15,'#b6b8ac',{font:'Mono',tracking:1.2});},{a:external});
 text('Office computer / your-app',1174,40,20,p.paper,{font:'Mono',align:'right'});
 rect(0,61,1200,54,'#e4e1d5');
 const tabs=[['Manage',24,154],['Terminal + editor',234,277],['Network',604,160],['Linux desktop',882,246]];
 let active=0;if(t>=7.5)active=1;if(t>=11.25)active=2;if(t>=16.875)active=3;
 tabs.forEach(([s,x,w],i)=>text(s,x,96,23,i===active?p.ink:p.muted,{weight:i===active?650:450}));
 const starts=[3.75,7.5,11.25,16.875],prior=Math.max(0,active-1),e=move(t,starts[active],.45);
 rect(lerp(tabs[prior][1],tabs[active][1],e),109,lerp(tabs[prior][2],tabs[active][2],e),5,p.orange,2);
 projectBar(t,d);
 c.restore();
}
function manageView(t){
 panel(24,222,744,229,p.white,9);
 const resources=[['CPU','4 cores'],['MEMORY','8 GB'],['DISK','40 GB']];
 resources.forEach(([a,b],i)=>{const x=49+i*235;micro(a,x,265);text(b,x,320,37,p.ink,{weight:600});if(i<2)line(x+210,252,x+210,346,col(p.ink,.12));});
 line(49,371,741,371,col(p.ink,.1));
 text(t>=4.9?'VM running on Office computer':'Ready on Office computer',49,416,25,p.ink,{weight:500});
 const run=t>=4.9,press=Math.sin(Math.PI*clamp((t-4.72)/.14));
 g(()=>{panel(798,222,378,111,run?p.ink:p.orange,9);text(run?'Stop VM':'Start VM',987,291,34,run?p.paper:p.ink,{weight:650,align:'center'});},{x:987*(press*.025),y:278*(press*.025),sx:1-press*.025});
 panel(798,350,378,101,null,9,col(p.ink,.25));text('Restart',987,412,29,p.ink,{align:'center'});
 micro('ACTIVITY',25,501);
 if(run){const q=ease((t-4.9)/.3);g(()=>{circle(38,547,6,p.orange);text('Started remotely',59,556,27,p.ink,{weight:550});text('4 CPU  /  8 GB RAM',1164,556,23,p.muted,{font:'Mono',align:'right'});},{a:q,y:12*(1-q)});}
}
function paneLayout(t){
 const p=move(t,11.05,.65),d=move(t,16.875,.6);
 return {lx:24,lw:lerp(lerp(552,338,p),438,d),rx:lerp(lerp(600,390,p),486,d),rw:lerp(lerp(576,786,p),690,d),y:222,h:379};
}
function paneBase(x,w,fill,heading,headingFill,headingColor=p.ink){panel(x,222,w,379,fill,9,col(p.ink,.15));c.save();c.beginPath();c.roundRect(x,222,w,379,9);c.clip();rect(x,222,w,49,headingFill);text(heading,x+20,255,21,headingColor,{weight:550});c.restore()}
function editorPanel(t,L,a=1){g(()=>{
 paneBase(L.lx,L.lw,p.white,'Your editor · App.tsx','#dfdcd0');
 const lines=['function App() {','  return <Checkout />','}','export default App;'];
 lines.forEach((s,i)=>{text(String(i+1),L.lx+18,329+i*48,19,'#aaa99d',{font:'Mono'});text(s,L.lx+52,329+i*48,24,i===0?p.orange:p.ink,{font:'Mono'});});
 capsule('SSH',L.lx+20,545,68,p.ink,p.paper,16);text('Connected to your-app',L.lx+106,571,19,p.muted,{font:'Mono'});
 },{a})}
function terminalPanel(t,L,a=1){g(()=>{
 paneBase(L.rx,L.rw,p.ink,'Your terminal','#2f3129',p.paper);
 micro('silo@your-app',L.rx+24,315,p.orange);
 typeLine('$ npm run dev',L.rx+24,377,29,(t-8.35)/.75,p.paper);
 const ready=ease((t-10.05)/.3);g(()=>{text('Server ready',L.rx+24,457,34,p.paper,{weight:600});capsule('0.0.0.0:3000',L.rx+22,484,245,p.orange,p.ink,23);},{a:ready,y:14*(1-ready)});
 micro('/workspace/your-app',L.rx+24,576,'#93968a');
 },{a})}
function networkPanel(t,L,a=1){g(()=>{
 paneBase(L.lx,L.lw,p.white,'Network','#dfdcd0');
 micro('VM PORT',L.lx+23,300);text('3000',L.lx+21,376,70,p.ink,{font:'Mono',weight:600});
 const on=t>=12.45;
 panel(L.lx+22,391,L.lw-44,51,on?p.ink:p.orange,5);text(on?'Connected':'Connect',L.lx+L.lw/2,424,23,on?p.paper:p.ink,{weight:600,align:'center'});
 const q=ease((t-12.52)/.4);g(()=>{line(L.lx+32,454,L.lx+32,473,p.orange,2);text('ON YOUR LAPTOP',L.lx+23,493,16,p.muted,{font:'Mono',tracking:.6});text('localhost:51432',L.lx+23,528,22,p.ink,{font:'Mono'});panel(L.lx+22,548,L.lw-44,36,p.orange,4);text('Open app ↗',L.lx+L.lw/2,573,21,p.ink,{weight:600,align:'center'});},{a:q,y:12*(1-q)});
 },{a})}
function lamp(x,y,size){
 g(()=>{rect(0,0,150,134,p.orange,8);c.save();c.lineCap='round';c.lineJoin='round';c.strokeStyle=p.ink;c.lineWidth=5;
 c.beginPath();c.moveTo(48,113);c.lineTo(103,113);c.moveTo(76,111);c.lineTo(76,58);c.moveTo(36,58);c.lineTo(56,22);c.lineTo(98,22);c.lineTo(119,58);c.closePath();c.stroke();line(36,58,119,58,p.ink,5);c.restore();circle(77,63,6,p.paper);},{x,y,sx:size/150})
}
function appBrowser(t,L,a=1){g(()=>{
 const d=move(t,16.875,.5),confirmed=ease((t-20.81)/.35);
 paneBase(L.rx,L.rw,p.white,'Browser','#dfdcd0');
 panel(L.rx+17,282,L.rw-34,35,p.paper,5,null);
 const addr=d<.5?'localhost:51432':'localhost:3000';text(addr,L.rx+33,307,21,p.ink,{font:'Mono'});
 text('Your application',L.rx+24,357,32,p.ink,{weight:650,tracking:-.7});
 line(L.rx+24,375,L.rx+L.rw-24,375,col(p.ink,.12));
 if(confirmed<1)g(()=>{
  lamp(L.rx+25,392,135);micro('TEST ORDER',L.rx+185,413);text('Studio lamp',L.rx+185,453,34,p.ink,{weight:600});text('$24.00',L.rx+187,497,29,p.ink,{font:'Mono'});
  panel(L.rx+24,539,L.rw-48,44,p.ink,5);text('Checkout',L.rx+L.rw/2,570,24,p.paper,{weight:600,align:'center'});
 },{a:1-confirmed,y:-10*confirmed});
 if(confirmed>0)g(()=>{
  const xx=L.rx+L.rw/2;circle(xx,443,34,p.orange);check(xx,443,22,p.ink);text('Order confirmed',xx,514,36,p.ink,{align:'center',weight:600,tracking:-.5});micro('RECEIPT #001',xx,551,p.muted,'center');
 },{a:confirmed,y:22*(1-confirmed)});
 },{a})}
function agentPanel(t,L,a=1){g(()=>{
 paneBase(L.lx,L.lw,p.ink,'Agent terminal','#2f3129',p.paper);
 micro('YOUR-APP / LINUX DESKTOP',L.lx+22,305,p.orange);
 typeLine('Test the checkout',L.lx+23,353,27,(t-17.45)/.75,p.paper);
 typeLine('and verify the result.',L.lx+23,391,25,(t-18.0)/.85,p.paper);
 const tasks=[['Read the screen',18.9,19.85],['Click Checkout',19.9,20.81],['Verify the result',20.9,21.78]];
 tasks.forEach(([name,start,done],i)=>{const q=ease((t-start)/.25);g(()=>{const yy=446+i*43;circle(L.lx+30,yy-6,4,p.orange);text(name,L.lx+47,yy,22,p.paper,{font:'Mono'});if(t>=done)check(L.lx+L.lw-26,yy-8,9,p.orange);},{a:q,y:9*(1-q)});});
 micro('AGENT INSTALLED IN THE VM',L.lx+23,581,'#919488');
 },{a})}
function persistentWorkspace(t){
 workspaceChrome(t);
 const L=paneLayout(t),ssh=ease((t-7.32)/.4),ports=ease((t-11.25)/.35),open=ease((t-14.12)/.35),desk=ease((t-16.875)/.45);
 const management=1-ssh;
 if(management>0)g(()=>manageView(t),{a:management,y:-12*ssh});
 if(ssh>0){
  editorPanel(t,L,ssh*(1-ports));networkPanel(t,L,ports*(1-desk));agentPanel(t,L,desk);
  terminalPanel(t,L,ssh*(1-open));appBrowser(t,L,open);
 }
 // User actions are in the controlling window; the agent pointer belongs to the guest.
 cursorTravel(t,4.03,4.72,[1188,603],[983,276],.35);
 cursorTravel(t,6.83,7.45,[983,276],[404,89],.28);
 cursorTravel(t,11.43,12.28,[465,158],[192,416],.30);
 cursorTravel(t,13.3,14.02,[192,416],[186,565],.22);
 cursorTravel(t,16.12,16.76,[189,565],[991,87],.2);
 const checkX=L.rx+L.rw/2;
 if(t>=19.32&&t<21.4){
  const u=move(t,19.32,1.43),a=Math.min(ease((t-19.32)/.13),1-ease((t-21.07)/.3));
  const xx=lerp(L.rx+L.rw-53,checkX,u),yy=lerp(363,559,u);
  smallCursor(xx,yy,a,Math.sin(Math.PI*clamp((t-20.75)/.16)));clickMark(checkX,559,t-20.81);
 }
}
function narrative(t){
 const zoom=move(t,6.8,.7),reveal=move(t,3.15,.6),dark=move(t,16.6,.65);
 bg(mixColor(p.paper,p.ink,dark));stageTitle(t,dark);
 const x=lerp(83,76,zoom),y=lerp(410,299,zoom),w=lerp(1024,1388,zoom),h=w*630/1200;
 const hostX=lerp(1470,1560,zoom),hostY=lerp(405,426,zoom),hostW=lerp(302,235,zoom);
 // A single wire retains the relationship between this laptop and the host.
 if(t>3.15){g(()=>{
  const x1=x+w+10,x2=hostX-12,yy=650;
  line(x1,yy,x2,yy,col(mixColor(p.ink,p.paper,dark),.2),2);
  if(t>4.9){const q=ease((t-4.9)/.5);line(x1,yy,lerp(x1,x2,q),yy,p.orange,3);for(let i=0;i<2;i++){const u=(t*.58+i*.5)%1;circle(lerp(x1,x2,u),yy,4,p.orange);}}
  text('SSH',lerp(x1,x2,.5),yy-21,18,mixColor(p.ink,p.paper,dark),{font:'Mono',align:'center'});
 },{a:reveal});}
 const host=hostMachine(t,zoom,dark);
 if(t<3.76){
  const collapse=move(t,2.8,.75);
  const positions=[[93,370,1125,207],[93,612,1125,207]];
  for(let i=0;i<2;i++){
   const [xx,yy,ww,hh]=positions[i],tx=host.x+24+i*((host.w-61)/2+13),ty=host.y+382;
   const q=clamp((t-i*.08+.1)/.5);
   g(()=>scopeCard(lerp(xx,tx,collapse),lerp(yy,ty,collapse),lerp(ww,(host.w-61)/2,collapse),lerp(hh,36,collapse),i,t,collapse),{a:ease(q),y:27*(1-ease(q))});
   if(collapse<.8){g(()=>{const cy=yy+hh/2;line(xx+ww+18,cy,host.x-21,cy,col(p.ink,.17),2);line(host.x-21,cy,host.x-21,host.vmy,col(p.ink,.17),2);line(host.x-21,host.vmy,host.x,host.vmy,p.orange,3);},{a:1-collapse});}
  }
  g(()=>{text('Configured on the hosting computer.',96,890,32,p.ink,{weight:500});micro('SELECTED REPOSITORIES. SCOPED CREDENTIALS.',96,939);},{a:1-collapse});
 }
 if(reveal>0){
  g(()=>{
   const hardware=1-zoom;
   g(()=>{panel(x-16,y-18,w+32,h+36,p.ink,18,null);c.beginPath();c.moveTo(x-16,y+h+18);c.lineTo(x-47,y+h+46);c.lineTo(x+w+47,y+h+46);c.lineTo(x+w+16,y+h+18);c.closePath();c.fillStyle='#55574b';c.fill();rect(x+w/2-115,y+h+18,230,8,'#85877a',2);},{a:hardware});
   depthPanel(x,y,w,h,p.white,13);
   g(()=>{c.save();c.beginPath();c.roundRect(0,0,1200,630,13);c.clip();persistentWorkspace(t);c.restore();},{x,y,sx:w/1200});
   g(()=>{text('Your laptop',x+1,y-49,31,p.ink,{weight:600});},{a:hardware});
  },{a:reveal,x:-100*(1-reveal),y:25*(1-reveal)});
 }
}

function resolve(t){
 bg(p.ink);const q=ease(t/.35);
 g(()=>{display('LESS SETUP.',77,494,356,p.paper,1748);display('MORE BUILDING.',77,841,307,p.paper,1748)},{a:1-smooth((t-.74)/.38),x:-160*(1-q)});
 const morph=smooth((t-.65)/.65),flat=smooth((t-.8)/.48);
 g(()=>ringMesh(t+5,960,540,lerp(1100,420,morph),flat),{a:morph*(1-smooth((t-1.30)/.2))});
 if(t>1.30)g(()=>brandMark(960,540,420,1,0,p.paper,p.orange),{a:ease((t-1.30)/.2)});
 if(t>1.55){const e=io((t-1.55)/.325);circle(960,540,2100*e,p.orange);}
}
function end(t){
 bg(p.orange);const e=spring(t/.75),s=lerp(.83,1,e);
 g(()=>{brandMark(569,409,254,1,0,p.ink,p.paper);text('Silo',772,528,330,p.ink,{weight:700,tracking:-19});},{sx:s,sy:s,x:960*(1-s),y:463*(1-s)});
 const q=ease((t-.25)/.48);g(()=>text('Computers for your agents.',960,687,58,p.ink,{weight:600,align:'center',tracking:-1.5}),{a:q,y:40*(1-q)});
 const u=ease((t-.5)/.4);g(()=>{rect(666,753,588,88,p.ink);text('Download Silo',960,812,39,p.paper,{weight:650,align:'center'});text('silo.polarzero.xyz',960,908,32,p.ink,{font:'Mono',align:'center',tracking:-.6});},{a:u,y:32*(1-u)});
 label('AVAILABLE FOR MACOS + LINUX',81,1017);label('LINUX VMs / LOCAL + REMOTE',1838,1017,p.ink,'right');
}

const noise=createCanvas(480,270),nc=noise.getContext('2d'),ni=nc.createImageData(480,270);let seed=927;
for(let k=0;k<ni.data.length;k+=4){seed=(seed*1664525+1013904223)>>>0;const v=seed>>>24;ni.data[k]=ni.data[k+1]=ni.data[k+2]=v;ni.data[k+3]=13}nc.putImageData(ni,0,0);
const cuts=[0,3.75,28.125,30];
const scenes=[opening,narrative,resolve,end];
function draw(t,target=ctx){c=target;c.resetTransform();c.globalAlpha=1;const i=cuts.findLastIndex(v=>v<=t);scenes[i](t-cuts[i]);c.save();c.globalCompositeOperation='soft-light';c.globalAlpha=.55;c.drawImage(noise,0,0,W,H);c.restore();}
const sampleCanvas=createCanvas(W,H),sampleCtx=sampleCanvas.getContext('2d');
function frame(t,blur=false){if(!blur){draw(t);return}for(let i=0;i<3;i++){draw(Math.max(0,t+(i-1)/240),sampleCtx);ctx.globalAlpha=1/(i+1);ctx.drawImage(sampleCanvas,0,0);ctx.getImageData(0,0,1,1)}ctx.globalAlpha=1;c=ctx;}

if(process.argv.includes('--stills')||process.argv.includes('--transitions')){
 const transitions=process.argv.includes('--transitions');
 const times=transitions?[6.45,6.65,6.9,7.1,7.35,10.5,10.75,11.,11.25,11.55,14.8,15.,15.25,17.6,18.,20.35,20.65,20.9,24.45,24.8]:[.45,1.65,2.95,4.5,5.95,7.85,9.2,10.5,11.9,13.1,14.25,15.7,17.2,18.6,20.,21.8,23.9,25.5,28.6,31.6];
 const board=createCanvas(2400,1350),b=board.getContext('2d');
 for(let i=0;i<times.length;i++){frame(times[i]);const frozen=cv.toBuffer('image/png');await writeFile(join(out,`${transitions?'transition':'directed-shot'}-${String(i+1).padStart(2,'0')}.png`),frozen);b.drawImage(await loadImage(frozen),i%5*480,Math.floor(i/5)*337.5+25,480,270);b.fillStyle=p.paper;b.font='18px sans-serif';b.fillText(times[i].toFixed(2)+'s',i%5*480+10,Math.floor(i/5)*337.5+322)}
 await writeFile(join(out,transitions?'directed-transitions.jpg':'directed-storyboard.jpg'),board.toBuffer('image/jpeg',95));console.log('20 storyboard frames rendered.');
}else if(process.argv.includes('--frame')){frame(Number(process.argv[process.argv.indexOf('--frame')+1]),true);await writeFile(join(out,'frame.png'),cv.toBuffer('image/png'));}
else if(process.argv.includes('--render')||process.argv.includes('--draft')){
 const draft=process.argv.includes('--draft'),renderFPS=draft?24:FPS;
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(renderFPS),'-i','pipe:0','-an','-c:v','libx264','-preset',draft?'ultrafast':'fast','-crf',draft?'24':'16',...(draft?['-vf','scale=960:540']:[]),'-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',join(out,draft?'draft.mp4':'picture.mp4')],{stdio:['pipe','inherit','inherit']});
 ff.stdin.on('error',err=>{throw err});
 for(let n=0;n<renderFPS*DURATION;n++){frame(n/renderFPS,!draft);if(!ff.stdin.write(cv.data()))await once(ff.stdin,'drain');if(n%renderFPS===0)console.log(`${n/renderFPS} / ${DURATION} seconds`)}
 ff.stdin.end();const [code]=await once(ff,'close');if(code)throw Error('FFmpeg failed: '+code);console.log('Picture rendered.');
}

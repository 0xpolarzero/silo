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
const W=1920,H=1080,FPS=60,DURATION=15,B=60/128,BAR=4*B;
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

function opening(t){bg(p.paper);const step=t<B?0:t<2*B?1:2;const u=t-step*B;
 if(step===0){const s=spring(t/.5);display('YOUR',104,820,870,p.ink,1715,{tracking:-15});rect(98,872,lerp(0,1719,ease(t/.37)),35,p.orange);g(()=>label('SILO / SPACE FOR YOUR NEXT IDEA',101,131),{a:ease(t/.2)});circle(1767,139,12,p.orange);}
 if(step===1){bg(p.orange);const e=ease(u/.3);g(()=>display('NEXT',72,814,870,p.ink,1775),{sx:lerp(1.3,1,e),sy:lerp(.55,1,e),x:-160*(1-e),y:280*(1-e)});label('MAKE SOMETHING',100,122);label('THAT DIDN’T EXIST.',1815,984,p.ink,'right');}
 if(step===2){bg(p.ink);const e=ease(u/.27);g(()=>display('MACHINE.',74,653,500,p.paper,1777),{x:130*(1-e),sy:lerp(1.6,1,e),y:-270*(1-e)});label('LINUX. ISOLATED. YOURS.',99,855,p.paper);line(98,895,1819,895,col(p.paper,.4));
   const v=smooth((t-1.37)/.505);if(v>0){const dims=lerp(0,460,spring(v));polygons(cubeFaces([0,0,0],dims,-.54,.61+v*.22,.08,{cx:960,cy:548,scale:1,cam:1700}));}
 }
}
function machine(t){bg(p.paper);const e=ease(t/.45);ground(t);const exp=smooth((t-.53)/.82);const rx=-.54-t*.27,ry=.83+t*.83,rz=.08-t*.16;
 const camera={cx:960,cy:526,cam:1650,scale:lerp(1.37,1.04,exp)};
 const fs=[];for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
  const d=105+exp*86;fs.push(...cubeFaces([x*d,y*d,z*d],99,rx,ry,rz,camera));
 }
 g(()=>polygons(fs),{sx:lerp(1.08,1,e),sy:lerp(1.08,1,e),x:-960*.08*(1-e),y:-526*.08*(1-e)});
 wireCube([0,0,0],(390+exp*270),rx,ry,rz,camera,col(p.ink,.28));
 label('01 / EVERY SANDBOX',81,97);label('A WORLD OF ITS OWN',1839,97,p.ink,'right');
 g(()=>{display('REAL LINUX.',78,996,178,p.ink,918);label('FILES. TOOLS. PROCESSES.',1824,976,p.ink,'right')},{y:90*(1-e),a:e});
 const endpoints=[[284,288],[1576,244],[1610,795]];endpoints.forEach(([x,y],i)=>{const v=ease((t-.3-i*.16)/.5);if(v){line(x,y,lerp(x,960+(i?180:-180),v),lerp(y,440+i*100,v),col(p.ink,.35));circle(x,y,4,p.orange);}});
}
function network(t){bg(p.orange);const e=ease(t/.4);const split=smooth(t/1.1);const rx=-.48,ry=.5+t*.56;
 const all=[];for(let side=-1;side<=1;side+=2){for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++){
  const v=rotate([x*82,y*82,0],rx,side*ry,.05*side);const center=[v[0]+side*lerp(250,490,split),v[1],v[2]];
  all.push(...cubeFaces(center,70,0,0,0,{cx:960,cy:560,scale:1.25,localRotation:[-.45,side*.6,.12],stroke:col(p.paper,.7)},['#181a17','#30302b','#10120f','#272a23','#555548','#11140f']));
 }}polygons(all);
 c.save();c.strokeStyle=p.paper;c.lineWidth=2;for(let j=-2;j<=2;j++){c.beginPath();c.moveTo(445,542+j*46);c.bezierCurveTo(700,310+j*65,1200,820-j*65,1476,545+j*46);c.stroke();for(let k=0;k<3;k++){const u=((t*.6+k/3+j*.08)%1+1)%1;const a=[445,542+j*46],b=[700,310+j*65],d=[1200,820-j*65],f=[1476,545+j*46];const v=1-u;const x=v**3*a[0]+3*v*v*u*b[0]+3*v*u*u*d[0]+u**3*f[0],y=v**3*a[1]+3*v*v*u*b[1]+3*v*u*u*d[1]+u**3*f[1];circle(x,y,5,p.paper)}}c.restore();
 const local=ease(t/.24);clipBox(0,90,W,225,()=>g(()=>display('LOCAL.',76,286,244,p.ink,720),{x:-200*(1-local)}));
 const re=ease((t-.28)/.27);clipBox(0,747,W,270,()=>g(()=>display('REMOTE.',817,993,244,p.ink,1025),{x:400*(1-re)}));
 label('YOUR HARDWARE',83,1026);label('CONNECTED OVER SSH',1836,113,p.ink,'right');
 const q=ease((t-.98)/.38);g(()=>{rect(655,487,610,143,p.paper,0);display('ONE SILO.',684,600,134,p.ink,552);},{a:q,sx:lerp(.4,1,q),sy:lerp(.4,1,q),x:960*(1-lerp(.4,1,q)),y:552*(1-lerp(.4,1,q))});
}

function texText(target,fn){const prev=c;c=target;fn();c=prev}
const desktopTexture=createCanvas(1080,640),dc=desktopTexture.getContext('2d');
function desktopMap(t){texText(dc,()=>{bg(p.paper);rect(0,0,1080,68,p.ink);circle(34,34,8,p.orange);circle(64,34,8,p.paper);circle(94,34,8,p.paper);label('LINUX DESKTOP',1034,42,p.paper,'right');
 rect(36,105,454,493,p.orange);display('>_',72,411,280,p.ink,331);label('TERMINAL',72,555);
 rect(515,105,529,493,p.white,0,p.ink,3);rect(515,105,529,55,p.paper,0,p.ink,3);label('localhost',544,141);display('MAKE',550,329,173,p.ink,442);display('IT REAL.',550,488,159,p.ink,440);rect(550,521,272,38,p.ink);label('BROWSER',844,550,p.ink);
})}
function texturedTri(im,a,b,d,sa,sb,sd){c.save();c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.lineTo(d[0],d[1]);c.closePath();c.clip();
 const det=sa[0]*(sb[1]-sd[1])+sb[0]*(sd[1]-sa[1])+sd[0]*(sa[1]-sb[1]);
 const A=(a[0]*(sb[1]-sd[1])+b[0]*(sd[1]-sa[1])+d[0]*(sa[1]-sb[1]))/det;
 const B=(a[1]*(sb[1]-sd[1])+b[1]*(sd[1]-sa[1])+d[1]*(sa[1]-sb[1]))/det;
 const C=(a[0]*(sd[0]-sb[0])+b[0]*(sa[0]-sd[0])+d[0]*(sb[0]-sa[0]))/det;
 const D=(a[1]*(sd[0]-sb[0])+b[1]*(sa[0]-sd[0])+d[1]*(sb[0]-sa[0]))/det;
 const E=(a[0]*(sb[0]*sd[1]-sd[0]*sb[1])+b[0]*(sd[0]*sa[1]-sa[0]*sd[1])+d[0]*(sa[0]*sb[1]-sb[0]*sa[1]))/det;
 const F=(a[1]*(sb[0]*sd[1]-sd[0]*sb[1])+b[1]*(sd[0]*sa[1]-sa[0]*sd[1])+d[1]*(sa[0]*sb[1]-sb[0]*sa[1]))/det;
 c.transform(A,B,C,D,E,F);c.drawImage(im,0,0);c.restore();
}
function plane(im,rx,ry,rz,opts={},z=0){const nx=8,ny=5;const pt=(u,v)=>project(rotate([(u-.5)*1080,(v-.5)*640,z],rx,ry,rz),opts);for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const u=x/nx,v=y/ny,U=(x+1)/nx,V=(y+1)/ny;const a=pt(u,v),b=pt(U,v),d=pt(U,V),e=pt(u,V);texturedTri(im,a,b,d,[u*1080,v*640],[U*1080,v*640],[U*1080,V*640]);texturedTri(im,a,d,e,[u*1080,v*640],[U*1080,V*640],[u*1080,V*640])}}
function pointer(x,y,s=1,r=0,color=p.ink){g(()=>{c.beginPath();c.moveTo(0,0);c.lineTo(4,172);c.lineTo(47,128);c.lineTo(81,202);c.lineTo(119,184);c.lineTo(83,116);c.lineTo(143,107);c.closePath();c.fillStyle=color;c.fill();c.lineWidth=5;c.strokeStyle=p.paper;c.stroke()},{x,y,sx:s,r})}
function desktop(t){bg(p.ink);const e=ease(t/.5);const rx=lerp(.8,-.11,e)+Math.sin(t*2)*.06,ry=lerp(-.7,.18,e),rz=lerp(-.26,.06,e);desktopMap(t);
 const cam={cx:960,cy:568,cam:1700,scale:1.10};
 for(let i=3;i>=1;i--){g(()=>plane(desktopTexture,rx,ry,rz,{...cam,cy:568+i*25},i*53),{a:.08+.07*(3-i)})}
 plane(desktopTexture,rx,ry,rz,cam);
 label('03 / COMPUTER USE',84,98,p.paper);label('OPTIONAL LINUX DESKTOP',1837,98,p.paper,'right');
 clipBox(0,130,W,183,()=>g(()=>display('ROOM FOR YOUR AGENTS.',78,277,171,p.paper,1763),{y:-240*(1-ease(t/.28))}));
 label('CODEX / CLAUDE CODE / CURSOR',86,1003,p.paper);label('+ MORE',1836,1003,p.paper,'right');
 const q=io((t-.26)/.88);const x=lerp(1670,1288,q),y=lerp(840,669,q);pointer(x,y,lerp(1.95,1.1,q),lerp(-.28,0,q),p.orange);
 const tap=smooth((t-1.17)/.4);if(tap>0){for(let i=0;i<3;i++){circle(1300,685,(70+tap*420)*(1-i*.22),null,col(p.orange,(1-tap)*.8),5-i)} }
 if(t>1.65){const w=ease((t-1.65)/.225);rect(0,1080*(1-w),W,H,p.orange)}
}
function access(t){bg(p.paper);const turn=t*1.9;const e=ease(t/.4);const strip=smooth((t-.73)/.56);
 display('YOUR',75,396,390,p.ink,824);display('RULES.',643,948,448,p.ink,1197);
 const ringR=lerp(209,302,strip);g(()=>{
  for(let i=0;i<3;i++){const r=ringR-i*63;c.lineWidth=37;c.lineCap='butt';c.strokeStyle=i===2?p.orange:p.ink;c.beginPath();c.arc(0,0,r,turn+i*1.22,turn+i*1.22+TAU*.79);c.stroke()}
 },{x:1367,y:344,sx:lerp(.65,1,e),r:-.2});
 const tags=[['REPOSITORIES','READ ONLY'],['CREDENTIALS','SCOPED']];
 tags.forEach(([a,b],i)=>{const v=ease((t-.23-i*.2)/.45);g(()=>{rect(83,467+i*104,828,88,i===0?p.orange:p.ink);text(a,113,522+i*104,28,i===0?p.ink:p.paper,{font:'Mono'});text(b,877,522+i*104,28,i===0?p.ink:p.paper,{font:'Mono',align:'right'});},{x:-940*(1-v)});});
 label('04 / CHOOSE WHAT GETS IN',83,92);label('PER SANDBOX',1838,1029,p.ink,'right');
 const gate=smooth((t-1.43)/.445);if(gate>0){g(()=>{for(let i=0;i<13;i++){const y=i*93;rect(lerp(-2100,1920,gate)-i*75,y,1970,58,p.orange)}},{r:-.06,y:0});}
}
function miniMark(x,y,size,t){g(()=>{brandMark(0,0,size,1,t*.3,p.paper,p.orange)},{x,y})}
function collage(t){bg(p.orange);const e=ease(t/.26);const sc=lerp(1.24,1,e);g(()=>{
 const gap=17,ax=71,ay=75,cw=577,ch=449;
 rect(ax,ay,cw,ch,p.ink);display('BUILD',ax+27,ay+330,344,p.paper,cw-54);label('01 / SOMETHING NEW',ax+27,ay+413,p.orange);
 rect(ax+cw+gap,ay,cw,ch,p.paper);for(let i=0;i<15;i++){const y=ay+29+i*27;const k=.5+.5*Math.sin(t*4-i*.56);rect(ax+cw+gap+32,y,lerp(60,510,k),9,p.ink)}
 rect(ax+2*(cw+gap),ay,cw,ch,p.ink);miniMark(ax+2*(cw+gap)+cw/2,ay+ch/2,355,t);
 rect(ax,ay+ch+gap,cw,ch,p.paper);const opts={cx:ax+cw/2,cy:ay+ch+gap+ch/2,cam:1600,scale:1.0};polygons(cubeFaces([0,0,0],245,-.5,t*1.6,-.15,opts));
 rect(ax+cw+gap,ay+ch+gap,cw,ch,p.ink);display('>_',ax+cw+gap+70,ay+2*ch-44,336,p.orange,436);label('YOUR TOOLS',ax+cw+gap+30,ay+2*ch+gap-30,p.paper);
 rect(ax+2*(cw+gap),ay+ch+gap,cw,ch,p.paper);display('YOURS.',ax+2*(cw+gap)+25,ay+ch+gap+283,205,p.ink,cw-50);label('ON YOUR COMPUTERS',ax+2*(cw+gap)+25,ay+2*ch+gap-30);
 },{sx:sc,sy:sc,x:960*(1-sc),y:540*(1-sc),r:Math.sin(t*2)*.012});
 if(t>.86){const z=io((t-.86)/1.015);const s=1+z*3.7;g(()=>{rect(-400,-370,800,740,p.paper);display('YOURS.',-355,112,316,p.ink,710);label('ON YOUR COMPUTERS',-354,220)},{x:lerp(1550,960,z),y:lerp(753,540,z),sx:s,sy:s,a:ease((t-.86)/.13),r:lerp(.015,0,z)})}
}
function ringMesh(t,x,y,size,flatten=0){const dots=[],rx=lerp(-.7,0,flatten),ry=lerp(t*.66,0,flatten);for(let ring=0;ring<3;ring++){
 const R=[39*600/92,26*600/92,13*600/92][ring],start=[-28,63,154][ring]*Math.PI/180,span=[200/39,126/26,58/13][ring];
 for(let i=0;i<110;i++){const a=start+span*i/109;for(let j=0;j<4;j++){const r=R+(j-1.5)*14.2;const v=rotate([Math.cos(a)*r,Math.sin(a)*r,Math.sin((a+t)*3)*22*(1-flatten)],rx,ry);dots.push({pt:project(v,{cx:x,cy:y,scale:size/600,cam:1700}),ring})}}
 }
 dots.sort((a,b)=>b.pt[2]-a.pt[2]);dots.forEach(({pt,ring})=>circle(pt[0],pt[1],5*size/600,ring===2?p.orange:p.paper));
}
function resolve(t){bg(p.ink);const compress=smooth(t/.95);const x=lerp(1400,960,compress),sz=lerp(1020,470,compress);
 g(()=>display('YOURS.',-110,821,825,p.paper,2150),{a:1-ease(t/.65),x:-240*ease(t/.65)});
 const morph=smooth((t-.82)/.35);g(()=>ringMesh(t+5,x,535,sz,compress),{a:1-morph});
 if(morph>0){g(()=>brandMark(960,535,450,1,0,p.paper,p.orange),{a:morph});}
 label('SILO',81,99,p.paper);label('SPACE TO BUILD.',1840,997,p.paper,'right');
 if(t>1.08){const e=io((t-1.08)/.32);circle(960,540,2100*e,p.orange);}
}
function end(t){bg(p.orange);const e=spring(t/.7);g(()=>{brandMark(569,468,254,1,0,p.ink,p.paper);text('Silo',772,587,330,p.ink,{weight:700,tracking:-19});},{sx:lerp(.83,1,e),sy:lerp(.83,1,e),x:960*(1-lerp(.83,1,e)),y:520*(1-lerp(.83,1,e))});
 const q=ease((t-.24)/.48);g(()=>{text('Linux sandboxes. On your computers.',960,735,44,p.ink,{weight:500,align:'center',tracking:-1.2});},{a:q,y:40*(1-q)});
 const u=ease((t-.44)/.4);g(()=>{rect(632,825,656,83,p.ink,0);text('silo.polarzero.xyz',960,881,35,p.paper,{font:'Mono',weight:500,align:'center',tracking:-.7});},{a:u,y:32*(1-u)});
 label('MACOS + LINUX',81,1017);label('YOUR MACHINES. YOUR RULES.',1838,1017,p.ink,'right');
}
const noise=createCanvas(480,270),nc=noise.getContext('2d'),ni=nc.createImageData(480,270);let seed=927;
for(let k=0;k<ni.data.length;k+=4){seed=(seed*1664525+1013904223)>>>0;const v=seed>>>24;ni.data[k]=ni.data[k+1]=ni.data[k+2]=v;ni.data[k+3]=13}nc.putImageData(ni,0,0);
const cuts=[0,BAR,2*BAR,3*BAR,4*BAR,5*BAR,6*BAR,12.65625];
const scenes=[opening,machine,network,desktop,access,collage,resolve,end];
function draw(t,target=ctx){c=target;c.resetTransform();c.globalAlpha=1;const i=cuts.findLastIndex(v=>v<=t);scenes[i](t-cuts[i]);c.save();c.globalCompositeOperation='soft-light';c.globalAlpha=.55;c.drawImage(noise,0,0,W,H);c.restore();}
const sampleCanvas=createCanvas(W,H),sampleCtx=sampleCanvas.getContext('2d');
function frame(t,blur=false){if(!blur){draw(t);return}for(let i=0;i<3;i++){draw(Math.max(0,t+(i-1)/240),sampleCtx);ctx.globalAlpha=1/(i+1);ctx.drawImage(sampleCanvas,0,0);ctx.getImageData(0,0,1,1)}ctx.globalAlpha=1;c=ctx;}

if(process.argv.includes('--stills')){
 const times=[.2,.69,1.3,2.3,3.3,4.4,5.1,6.4,7.08,8.28,9,9.95,10.8,11.68,12.2,13.75];
 const board=createCanvas(1920,1080),b=board.getContext('2d');
 for(let i=0;i<times.length;i++){frame(times[i]);const frozen=cv.toBuffer('image/png');await writeFile(join(out,`shot-${String(i+1).padStart(2,'0')}.png`),frozen);b.drawImage(await loadImage(frozen),i%4*480,Math.floor(i/4)*270,480,270)}
 await writeFile(join(out,'storyboard.jpg'),board.toBuffer('image/jpeg',95));console.log('16 storyboard frames rendered.');
}else if(process.argv.includes('--frame')){frame(Number(process.argv[process.argv.indexOf('--frame')+1]),true);await writeFile(join(out,'frame.png'),cv.toBuffer('image/png'));}
else if(process.argv.includes('--render')){
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',join(out,'picture.mp4')],{stdio:['pipe','inherit','inherit']});
 ff.stdin.on('error',err=>{throw err});
 for(let n=0;n<FPS*DURATION;n++){frame(n/FPS,true);if(!ff.stdin.write(cv.data()))await once(ff.stdin,'drain');if(n%60===0)console.log(`${n/60} / ${DURATION} seconds`)}
 ff.stdin.end();const [code]=await once(ff,'close');if(code)throw Error('FFmpeg failed: '+code);console.log('Picture rendered.');
}

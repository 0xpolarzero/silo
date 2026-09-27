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

function texText(target,fn){const prev=c;c=target;fn();c=prev}
const desktopTexture=createCanvas(1080,640),dc=desktopTexture.getContext('2d');
const laptopTexture=createCanvas(1080,640),lc=laptopTexture.getContext('2d');
function texturedTri(im,a,b,d,sa,sb,sd){c.save();const mid=[(a[0]+b[0]+d[0])/3,(a[1]+b[1]+d[1])/3];const expand=q=>{const dx=q[0]-mid[0],dy=q[1]-mid[1],len=Math.hypot(dx,dy);return[q[0]+dx/len*2.1,q[1]+dy/len*2.1]};const A0=expand(a),B0=expand(b),D0=expand(d);c.beginPath();c.moveTo(...A0);c.lineTo(...B0);c.lineTo(...D0);c.closePath();c.clip();
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

function desktopMap(t){texText(dc,()=>{
 bg(p.paper);rect(0,0,1080,58,p.ink);circle(29,29,7,p.orange);circle(53,29,7,p.paper);circle(77,29,7,p.paper);
 text('your-app / Linux desktop',1046,39,24,p.paper,{align:'right',weight:600});
 rect(24,83,438,532,p.ink,0);rect(24,83,438,47,p.orange);text('Agent terminal',45,116,23,p.ink,{font:'Mono'});
 text('$ claude',46,187,31,p.orange,{font:'Mono',weight:500});
 typeLine('Open the app and',46,244,24,(t-.4)/.65);typeLine('test the checkout.',46,279,24,(t-.8)/.7);
 const tasks=['Read the screen','Click Checkout','Inspect the result'];
 tasks.forEach((s,i)=>{const q=ease((t-1.65-i*.67)/.2);g(()=>{circle(56,344+i*56,5,p.orange);text(s,76,354+i*56,23,p.paper,{font:'Mono'});if(t>[2.3,3.3,4.12][i])check(422,346+i*56,11,p.orange)},{a:q,y:12*(1-q)});});
 text('/workspace/your-app',47,581,19,col(p.paper,.55),{font:'Mono'});
 rect(486,83,570,532,p.white,0,p.ink,2);rect(486,83,570,55,p.paper,0,p.ink,2);
 text('localhost:3000',512,119,22,p.ink,{font:'Mono'});
 const clicked=t>3.26;
 text('Your application',520,195,35,p.ink,{weight:650});line(518,222,1024,222,col(p.ink,.2));
 if(!clicked){
  rect(520,251,155,151,p.orange);circle(597,326,50,null,p.ink,7);line(556,291,637,364,p.ink,7);
  text('Test order',708,290,32,p.ink,{weight:650});text('1 item',710,335,24,p.muted);text('$24.00',710,385,32,p.ink,{font:'Mono'});
  rect(521,457,502,82,p.ink);text('Checkout',772,508,29,p.paper,{align:'center',weight:600});
 }else{
  const q=ease((t-3.26)/.25);g(()=>{circle(768,334,67,p.orange);check(768,334,47,p.ink);text('Order confirmed',772,451,35,p.ink,{align:'center',weight:650});text('Receipt #001',772,497,22,p.muted,{font:'Mono',align:'center'})},{a:q,sy:lerp(.8,1,q),y:60*(1-q)});
 }
 text('BROWSER',1022,587,18,p.muted,{font:'Mono',align:'right',tracking:2});
})}

function desktop(t){
 bg(p.ink);header('02','YOUR-APP / A DESKTOP + COMPUTER USE',p.paper);
 const e=1;
 clipBox(0,115,W,218,()=>g(()=>display('GIVE AGENTS A DESKTOP.',78,278,163,p.paper,1764),{y:-240*(1-e)}));
 desktopMap(t);
 const rx=lerp(.67,-.035,e)+Math.sin(t*.9)*.022,ry=lerp(-.72,.065,e),rz=lerp(-.25,.025,e);
 const cam={cx:960,cy:641,cam:1850,scale:1.01};
 for(let i=3;i>=1;i--)g(()=>plane(desktopTexture,rx,ry,rz,{...cam,cy:641+i*15},i*46),{a:.065+(3-i)*.036});
 plane(desktopTexture,rx,ry,rz,cam);
 const target=project(rotate([232,178,0],rx,ry,rz),cam);const m=io((t-1.7)/1.4),px=lerp(1636,target[0],m),py=lerp(771,target[1],m);
 if(t>1.4)pointer(px,py,lerp(1.65,.77,m)*(1-.12*Math.sin(Math.PI*clamp((t-3.18)/.18))),-.05,p.orange);
 if(t>3.26&&t<3.86){const q=(t-3.26)/.6;for(let i=0;i<3;i++)circle(target[0],target[1],28+q*250-i*17,null,col(p.orange,1-q),3)}
 text('Install your agent inside the VM.',1836,1023,24,col(p.paper,.65),{align:'right'});
 if(t>4.6875){
  // The desktop folds into the same VM; the access view grows from its frame.
  const q=io((t-4.6875)/.9375);
  g(()=>clipBox(lerp(400,0,q),lerp(310,0,q),lerp(1120,W,q),lerp(710,H,q),()=>access(0,ease((q-.8)/.2))),{a:smooth((t-4.6875)/.14)});
  if(q<.999){
   const cam2={cx:960,cy:lerp(641,597,q),cam:1850,scale:1.01*(1-q)};
   plane(desktopTexture,lerp(rx,-.5,q),lerp(ry,.65,q),lerp(rz,.06,q),cam2);
  }
 }
}

function clickRipple(x,y,t,color=p.orange){
 if(t<0||t>.48)return;
 const q=t/.48;for(let i=0;i<3;i++)circle(x,y,12+q*92+i*15,null,col(color,(1-q)*.65),3);
}
function laptopScreen(t){
 // Coordinates are local to the 1080 × 640 screen texture.
 const phase=t<3.75?0:t<7.5?1:2,run=t>1.48,terminal=t>4.5,connected=t>8.72,browser=t>10.13;
 bg(p.paper);rect(0,0,1080,72,p.ink);brandMark(38,36,43,1,0,p.paper,p.orange);text('Silo',80,49,37,p.paper,{weight:650});
 if(phase===0||phase===2&&!browser){
  text(phase===2?'Network':'Sandboxes',1042,48,28,p.paper,{align:'right',weight:600});
  rect(0,72,254,568,'#dfdbcf');
  text('COMPUTERS',25,118,21,p.muted,{font:'Mono'});
  text('This computer',26,173,25,p.ink);rect(12,199,230,59,p.ink);text('Office computer',27,237,25,p.paper);
  text('your-app',286,144,40,p.ink,{weight:650});text('Linux VM · Office computer',286,188,25,p.muted);
  circle(309,240,8,run?p.orange:p.muted);text(run?'Running':'Stopped',332,250,27,p.ink,{weight:600});
  if(phase===0){
   rect(286,290,748,93,p.white);text('4 CPU',312,348,27,p.ink,{font:'Mono'});text('8 GB RAM',553,348,27,p.ink,{font:'Mono'});text('40 GB',840,348,27,p.ink,{font:'Mono'});
   rect(286,438,216,75,run?p.ink:p.orange);text(run?'Stop':'Start',394,487,29,run?p.paper:p.ink,{align:'center',weight:650});
   rect(524,438,228,75,null,0,col(p.ink,.3),2);text('Restart',638,487,29,p.ink,{align:'center'});
   text(run?'VM started on Office computer':'Ready to start',288,584,25,p.muted);
   if(run){for(let i=0;i<36;i++)rect(800+i*6,491-Math.sin(i*.8+t*5)**2*51,3,10+Math.sin(i*.8+t*5)**2*51,p.orange);}
  }else{
   rect(286,289,748,182,p.white);text('Development server',315,338,29,p.ink,{weight:650});
   text('VM port 3000',315,401,30,p.ink,{font:'Mono'});
   rect(754,366,249,70,connected?p.ink:p.orange);text(connected?'Connected':'Connect',878,412,26,connected?p.paper:p.ink,{align:'center',weight:650});
   if(t>=9.35){rect(286,480,478,66,p.orange);text('localhost:51432',313,519,30,p.ink,{font:'Mono'});rect(804,485,199,63,p.orange);text('Open ↗',903,527,27,p.ink,{weight:650,align:'center'});}
   text('The server stays inside your VM.',288,592,25,p.muted);
  }
 }else if(phase===1){
  text('your-app · Office computer',1045,47,26,p.paper,{align:'right'});
  if(!terminal){
   text('Connect to your VM',50,179,50,p.ink,{weight:650});
   rect(51,260,469,139,p.orange);text('Open terminal',285,343,37,p.ink,{weight:650,align:'center'});
   rect(547,260,481,139,p.ink);text('Open in editor',787,343,37,p.paper,{weight:650,align:'center'});
   text('SSH access to /workspace/your-app',52,524,29,p.muted,{font:'Mono'});
  }else{
   const e=ease((t-4.5)/.4);g(()=>{
    rect(22,99,531,515,p.white);rect(22,99,531,67,p.orange);text('Editor',48,143,31,p.ink,{weight:650});
    text('SSH: your-app',48,212,26,p.ink,{font:'Mono'});text('src / App.tsx',48,266,24,p.muted,{font:'Mono'});
    const code=['function App() {',' return <Checkout />','}','export default App;'];
    code.forEach((s,i)=>text(s,48,349+i*53,26,i===0?p.orange:p.ink,{font:'Mono'}));
    rect(576,99,482,515,p.ink);text('Terminal',603,143,31,p.paper,{weight:650});line(597,167,1035,167,col(p.paper,.2));
    text('silo@your-app',603,215,26,p.orange,{font:'Mono'});
    typeLine('$ npm run dev',603,308,29,(t-4.9)/.65,p.paper);
    if(t>5.75){text('Server ready',603,404,31,p.paper,{weight:650});text('0.0.0.0:3000',603,462,26,p.paper,{font:'Mono'});}
    text('/workspace/your-app',603,579,21,col(p.paper,.6),{font:'Mono'});
   },{y:220*(1-e),a:e});
  }
 }else{
  // The same example application is used in the subsequent VM desktop scene.
  text('Browser',1042,48,28,p.paper,{align:'right',weight:600});
  const q=ease((t-10.13)/.35);g(()=>{
   rect(23,91,1034,65,p.white);text('localhost:51432',53,136,32,p.ink,{font:'Mono'});
   text('Your application',51,245,46,p.ink,{weight:650});line(51,281,1028,281,col(p.ink,.18));
   rect(53,318,241,207,p.orange);circle(174,421,70,null,p.ink,8);line(125,372,222,470,p.ink,8);
   text('Test order',337,369,44,p.ink,{weight:650});text('1 item · $24.00',340,439,32,p.muted,{font:'Mono'});
   rect(673,352,352,109,p.ink);text('Checkout',849,420,37,p.paper,{align:'center',weight:650});
   text('Served from your-app on Office computer',54,592,27,p.muted);
  },{y:100*(1-q),a:q});
 }
}

function remoteComputer(t){
 const running=t>1.48,serving=t>5.75;
 // Tower silhouette and enclosing case distinguish the host from its VM.
 c.beginPath();c.moveTo(1340,405);c.lineTo(1400,360);c.lineTo(1810,360);c.lineTo(1750,405);c.closePath();c.fillStyle='#45463e';c.fill();
 c.beginPath();c.moveTo(1750,405);c.lineTo(1810,360);c.lineTo(1810,901);c.lineTo(1750,944);c.closePath();c.fillStyle='#31322c';c.fill();
 rect(1340,405,410,539,p.ink);circle(1709,444,7,running?p.orange:p.muted);
 text('OFFICE COMPUTER',1367,451,21,p.paper,{font:'Mono',tracking:.6});
 for(let i=0;i<7;i++)line(1368+i*17,893,1368+i*17,919,col(p.paper,.4),3);
 rect(1365,497,360,330,running?p.orange:'#56574d');
 text('your-app',1391,548,39,running?p.ink:p.paper,{weight:650});
 text('LINUX VM',1393,589,23,running?p.ink:p.paper,{font:'Mono',tracking:2});
 if(!serving){
  polygons(cubeFaces([0,0,0],102,-.48,.6+t*.37,.07,{cx:1547,cy:703,cam:1500,stroke:col(p.paper,.25)},running?['#191a17','#36382f','#11130f','#20221c','#555648','#141510']:['#484a40','#36382f','#33352b','#20221c','#66685a','#34362a']));
  text(running?'Running':'Stopped',1545,805,25,running?p.ink:p.paper,{align:'center',weight:650});
 }else{
  rect(1386,623,317,157,p.ink);text('$ npm run dev',1402,667,25,p.paper,{font:'Mono'});text('LISTENING',1402,716,21,p.orange,{font:'Mono',tracking:1});text(':3000',1402,758,32,p.paper,{font:'Mono'});
 }
 if(t>11.05){const q=ease((t-11.05)/.3);g(()=>{rect(1365,844,360,48,p.paper);text('Open desktop',1545,877,27,p.ink,{align:'center',weight:650});},{y:20*(1-q),a:q});}
}

function portCarrier(t){
 if(t<8.72||t>=9.35)return;
 const q=io((t-8.72)/.63),x=lerp(1386,89+286*852/1080,q),y=lerp(714,388+480*493/640,q)-Math.sin(q*Math.PI)*130;
 const w=lerp(317,478*852/1080,q),h=lerp(66,66*493/640,q);
 rect(x,y,w,h,p.orange,0);
 clipBox(x,y,w,h,()=>{
  const swap=smooth((q-.35)/.4),size=lerp(30,30*852/1080,q),baseline=lerp(43,39*493/640,q);
  text(':3000',x+21,y+baseline-swap*h,size,p.ink,{font:'Mono'});
  text('localhost:51432',x+21,y+baseline+(1-swap)*h,size,p.ink,{font:'Mono'});
 });
}

function enterDesktop(t){
 const q=io((t-12.1875)/.9375);
 rect(lerp(1365,0,q),lerp(497,0,q),lerp(360,W,q),lerp(330,H,q),p.ink,lerp(6,0,q));
 desktopMap(0);
 const cam={cx:lerp(1545,960,q),cy:lerp(662,641,q),cam:1850,scale:lerp(.3,1.01,q)};
 const rx=-.035*q,ry=.065*q,rz=.025*q;
 for(let i=3;i>=1;i--)g(()=>plane(desktopTexture,rx,ry,rz,{...cam,cy:cam.cy+i*15*q},i*46*q),{a:(.065+(3-i)*.036)*q});
 plane(desktopTexture,rx,ry,rz,cam);
 const title=ease((q-.6)/.4);
 g(()=>{header('02','YOUR-APP / A DESKTOP + COMPUTER USE',p.paper);clipBox(0,115,W,218,()=>g(()=>display('GIVE AGENTS A DESKTOP.',78,278,163,p.paper,1764),{y:-220*(1-title)}));text('Install your agent inside the VM.',1836,1023,24,col(p.paper,.65),{align:'right'});},{a:title});
}
function connection(t){
 const port=t>8.72,active=t>1.1,y=638;
 const x1=974,x2=1324;
 line(x1,y,x2,y,col(p.ink,.18),3);
 if(active){
  const e=ease((t-1.1)/.5);line(x1,y,lerp(x1,x2,e),y,p.ink,4);
  for(let i=0;i<3;i++){const u=((t*1.05+i/3)%1),x=port?lerp(x2,x1,u):lerp(x1,x2,u);rect(x-8,y-7,17,14,t>=3.75&&t<7.5?p.paper:p.orange);}
  if(port)arrow(1194,y,1141,y,p.ink,5);else arrow(1141,y,1194,y,p.ink,5);
 }
 text(port?'PORT 3000':'SSH',1151,590,port?27:35,p.ink,{font:'Mono',align:'center',weight:600});
 if(port)text('FORWARDED',1151,693,20,p.muted,{font:'Mono',align:'center',tracking:1});
}
function workflow(t){
 const phase=t<3.75?0:t<7.5?1:2,u=t-[0,3.75,7.5][phase];
 bg(phase===1?p.orange:p.paper);header('01','YOUR-APP / OFFICE COMPUTER');
 const titles=['START IT HERE. RUN IT THERE.','CONNECT OVER SSH.','FROM SERVER TO BROWSER.'];
 const e=ease(u/.32);clipBox(0,126,W,175,()=>g(()=>display(titles[phase],78,283,171,p.ink,1764),{y:190*(1-e)}));
 text('YOUR LAPTOP',79,342,28,p.ink,{font:'Mono',tracking:1});text('OFFICE COMPUTER',1797,330,28,p.ink,{font:'Mono',align:'right',tracking:1});
 connection(t);remoteComputer(t);
 texText(lc,()=>laptopScreen(t));
 const enter=ease(t/.55);g(()=>{
  rect(69,365,892,541,p.ink,13);c.drawImage(laptopTexture,89,388,852,493);
  c.beginPath();c.moveTo(69,906);c.lineTo(29,950);c.lineTo(1001,950);c.lineTo(961,906);c.closePath();c.fillStyle='#34352e';c.fill();
  rect(358,907,309,13,p.muted,0);line(36,954,994,954,p.ink,5);
 },{x:-450*(1-enter),r:-.06*(1-enter),a:enter});
 const captions=['Start, stop and monitor VMs across your computers.','Your editor and terminal. The VM’s files and processes.','A server in the VM. An address on your laptop.'];
 text(captions[phase],79,1030,37,p.ink,{weight:500,tracking:-.5});
 const screenPoint=(x,y)=>[89+x*852/1080,388+y*493/640];
 let cursor=null,clickAt;
 if(t>.55&&t<2.1){const q=io((t-.55)/.74),target=screenPoint(390,475);cursor=[lerp(1045,target[0],q),lerp(1002,target[1],q)];clickAt=1.29;}
 if(t>3.83&&t<4.85){const q=ease((t-3.83)/.58),target=screenPoint(786,328);cursor=[lerp(1021,target[0],q),lerp(910,target[1],q)];clickAt=4.41;}
 if(t>7.73&&t<9.26){const q=io((t-7.73)/.83),target=screenPoint(871,401);cursor=[lerp(1119,target[0],q),lerp(956,target[1],q)];clickAt=8.56;}
 if(t>9.48&&t<10.8){const q=ease((t-9.48)/.52),target=screenPoint(903,520);cursor=[lerp(1026,target[0],q),lerp(949,target[1],q)];clickAt=10;}
 if(t>11.35&&t<12.23){const q=io((t-11.35)/.65);cursor=[lerp(923,1545,q),lerp(930,868,q)];clickAt=12;}
 if(cursor){pointer(...cursor,.58,0,p.orange);clickRipple(...cursor,t-clickAt);}
 portCarrier(t);
 if(t>12.1875)g(()=>enterDesktop(t),{a:smooth((t-12.1875)/.16)});
}

function access(t,chrome=1){
 bg(p.paper);g(()=>header('03','YOUR-APP / LINUX VM'),{a:chrome});
 const e=ease(t/.4);clipBox(0,124,W,177,()=>g(()=>display('CHOOSE WHAT IT CAN ACCESS.',78,280,171,p.ink,1764),{x:120*(1-e),a:e}));
 const left=ease(t/.55),right=ease((t-1.875)/.55);
 line(621,611,825,611,col(p.ink,.25),3);line(1091,611,1299,611,col(p.ink,.25),3);
 if(t>.9){for(let i=0;i<3;i++){const u=(t*.5+i/3)%1;rect(lerp(621,825,u),604,14,14,p.orange);}}
 if(t>2.8){for(let i=0;i<3;i++){const u=(t*.5+i/3)%1;rect(lerp(1299,1091,u),604,14,14,p.orange);}}
 const rx=-.5,ry=.65+t*.33;polygons(cubeFaces([0,0,0],164,rx,ry,.06,{cx:960,cy:597,cam:1700}));
 text('your-app',960,798,46,p.ink,{weight:650,align:'center'});label('LINUX VM',960,841,p.muted,'center');
 g(()=>{
  rect(79,359,542,527,p.ink);text('GitHub repositories',109,418,35,p.paper,{weight:650});
  const names=['your-app','design-system','private-project'];names.forEach((s,i)=>{
   const yy=491+i*111,on=i<2&&t>.65+i*.42;line(106,yy-30,593,yy-30,col(p.paper,.2));
   rect(108,yy,31,31,on?p.orange:null,0,on?p.orange:col(p.paper,.4),2);if(on)check(124,yy+16,16,p.ink);
   text(s,160,yy+27,27,on?p.paper:col(p.paper,.45),{font:'Mono'});
   if(on)text('Read only',160,yy+64,23,p.orange);
  });
  text('OAuth · Read-only by default',109,852,22,col(p.paper,.7));
 },{x:-200*(1-left),a:left});
 g(()=>{
  rect(1299,359,542,527,p.ink);text('API credentials',1329,418,35,p.paper,{weight:650});
  line(1326,461,1813,461,col(p.paper,.2));text('API key',1330,516,27,p.paper,{weight:600});text('•••• •••• ••••',1330,567,31,p.orange,{font:'Mono'});
  text('Allowed HTTPS domain',1330,647,23,col(p.paper,.65));rect(1328,677,483,64,p.paper);text('api.example.com',1347,719,27,p.ink,{font:'Mono'});check(1779,709,19);
  text('Stored on the hosting computer',1329,852,22,col(p.paper,.7));
 },{x:200*(1-right),a:right});
 g(()=>{rule(945);text('Selected repositories. Scoped credentials. For this VM.',80,1022,43,p.ink,{weight:500,tracking:-.7});},{a:chrome});
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
const cuts=[0,3.75,16.875,22.5,28.125,30];
const scenes=[opening,workflow,desktop,access,resolve,end];
function draw(t,target=ctx){c=target;c.resetTransform();c.globalAlpha=1;const i=cuts.findLastIndex(v=>v<=t);scenes[i](t-cuts[i]);c.save();c.globalCompositeOperation='soft-light';c.globalAlpha=.55;c.drawImage(noise,0,0,W,H);c.restore();}
const sampleCanvas=createCanvas(W,H),sampleCtx=sampleCanvas.getContext('2d');
function frame(t,blur=false){if(!blur){draw(t);return}for(let i=0;i<3;i++){draw(Math.max(0,t+(i-1)/240),sampleCtx);ctx.globalAlpha=1/(i+1);ctx.drawImage(sampleCanvas,0,0);ctx.getImageData(0,0,1,1)}ctx.globalAlpha=1;c=ctx;}

if(process.argv.includes('--stills')||process.argv.includes('--transitions')){
 const transitions=process.argv.includes('--transitions');
 const times=transitions?[12.48,12.65,12.85,13.08,13.2,15.5,15.94,16.15,16.4,16.7,16.87,17.0,21.56,21.75,21.95,22.15,22.35,22.49,22.6,23.0]:[.45,1.65,2.95,4.65,5.6,6.8,7.8,9.1,10.5,11.8,12.9,14.6,16.1,17.7,19.4,20.9,23.8,25.7,28.6,31.6];
 const board=createCanvas(2400,1350),b=board.getContext('2d');
 for(let i=0;i<times.length;i++){frame(times[i]);const frozen=cv.toBuffer('image/png');await writeFile(join(out,`${transitions?'transition':'flow-shot'}-${String(i+1).padStart(2,'0')}.png`),frozen);b.drawImage(await loadImage(frozen),i%5*480,Math.floor(i/5)*337.5+25,480,270);b.fillStyle=p.paper;b.font='18px sans-serif';b.fillText(times[i].toFixed(2)+'s',i%5*480+10,Math.floor(i/5)*337.5+322)}
 await writeFile(join(out,transitions?'transitions.jpg':'flow-storyboard.jpg'),board.toBuffer('image/jpeg',95));console.log('20 storyboard frames rendered.');
}else if(process.argv.includes('--frame')){frame(Number(process.argv[process.argv.indexOf('--frame')+1]),true);await writeFile(join(out,'frame.png'),cv.toBuffer('image/png'));}
else if(process.argv.includes('--render')){
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',join(out,'picture.mp4')],{stdio:['pipe','inherit','inherit']});
 ff.stdin.on('error',err=>{throw err});
 for(let n=0;n<FPS*DURATION;n++){frame(n/FPS,true);if(!ff.stdin.write(cv.data()))await once(ff.stdin,'drain');if(n%60===0)console.log(`${n/60} / ${DURATION} seconds`)}
 ff.stdin.end();const [code]=await once(ff,'close');if(code)throw Error('FFmpeg failed: '+code);console.log('Picture rendered.');
}

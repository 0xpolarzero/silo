import React from 'react';
import {AbsoluteFill,Img,staticFile,useCurrentFrame} from 'remotion';
import {Play,Square,Terminal as TerminalIcon,Code,ExternalLink,Plus,Check,ChevronDown,Copy,FileDown,Minus,ArrowUpRight,ChevronRight} from 'lucide-react';
import {SiloMark} from '@prod/components/silo-mark';
import {SandboxListRow,SandboxAction} from '@prod/features/sandboxes/components/sandbox-list';
import {ComputerBadge} from '@prod/features/sandboxes/components/computer-badge';
import {Button} from '@prod/components/ui/button';
import {TooltipProvider} from '@prod/components/ui/tooltip';
import {WorkspaceBadge,WorkspaceStatus} from '@prod/features/application/components/application-ui';
import cues from '../audio-cues.json';

type Q=[number,number][];
const E=Object.fromEntries(cues.events.map(x=>[x.label,x.frame]));
const C={ink:'#171717',paper:'#f5f4ef',orange:'#ff9f0a',green:'#168467',muted:'#777b79',guest:'#22352f'};
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const e=(x:number)=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10)};
const p=(f:number,a:number,b:number)=>e((f-a)/(b-a));
const m=(a:number,b:number,t:number)=>a+(b-a)*t;
const qmix=(a:Q,b:Q,t:number):Q=>a.map(([x,y],i)=>[m(x,b[i][0],t),m(y,b[i][1],t)]);
const abs=(left:number,top:number,width?:number,height?:number):React.CSSProperties=>({position:'absolute',left,top,width,height});
const office:any={id:'office',name:'Office Mac',address:'office.local',connected:true,busy:false};
const mono='"SFMono-Regular",Menlo,monospace';
function homography(q:Q,w:number,h:number){
 const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=q;
 const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3,dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;
 const z=dx1*dy2-dx2*dy1;const g=z?(dx3*dy2-dx2*dy3)/z:0,hh=z?(dx1*dy3-dx3*dy1)/z:0;
 const a=(x1-x0+g*x1)/w,b=(x3-x0+hh*x3)/h,d=(y1-y0+g*y1)/w,ee=(y3-y0+hh*y3)/h;
 return `matrix3d(${a},${d},0,${g/w},${b},${ee},0,${hh/h},0,0,1,0,${x0},${y0},0,1)`;
}
function Surface({q,w,h,children,radius=0,style={}}:{q:Q,w:number,h:number,children:React.ReactNode,radius?:number,style?:React.CSSProperties}){
 return <div style={{...abs(0,0,w,h),transformOrigin:'0 0',transform:homography(q,w,h),overflow:'hidden',borderRadius:radius,backfaceVisibility:'hidden',...style}}>{children}</div>;
}
function Cursor({x,y,agent=false,press=0,scale=1.5,opacity=1}:{x:number,y:number,agent?:boolean,press?:number,scale?:number,opacity?:number}){
 // Asset tip measured at (6,4) in the supplied 46x48 raster, or (3,2) at native CSS size.
 const s=scale*(1-.08*press);
 return agent?<Img src={staticFile('codex-agent-cursor.png')} style={{...abs(x-3*s,y-2*s,23*s,24*s),opacity,filter:`drop-shadow(0 0 ${6*s}px rgba(51,156,255,.9)) drop-shadow(0 0 ${15*s}px rgba(51,156,255,.48))`}}/>:
 <svg style={{...abs(x,y,25*s,33*s),opacity,overflow:'visible'}} viewBox="0 0 25 33"><path d="M1 1V26L8 19L14 31L19 28L13 17H24Z" fill="#fff" stroke="#171717" strokeWidth="1.7" strokeLinejoin="round"/></svg>;
}
function Row({width=1200,state='running',mode='normal',compact=false}:{width?:number,state?:'running'|'starting'|'stopped',mode?:string,compact?:boolean}){
 const sc=compact?2.15:3.15;return <div style={{width,height:compact?115:166,background:'#fff',color:C.ink,borderBottom:'1px solid #ddd'}}>
 <div style={{width:width/sc,transform:`scale(${sc})`,transformOrigin:'0 0'}}><TooltipProvider reduceMotion><SandboxListRow name="studio" kind="vm" remote badge={<ComputerBadge computer={office}/>} tone={state} detail={<WorkspaceStatus state={state}/>} actions={<>
 <SandboxAction label={state==='stopped'?'Start studio':'Stop studio'}>{state==='stopped'?<Play/>:<Square/>}</SandboxAction>
 {!compact&&<SandboxAction label="Open studio in Terminal"><TerminalIcon/></SandboxAction>}{!compact&&mode==='access'&&<SandboxAction label="Open studio in Editor"><Code/></SandboxAction>}
 </>}/></TooltipProvider></div></div>;
}
function TitleBar({label,children,dark=false}:{label:string,children?:React.ReactNode,dark?:boolean}){
 return <div style={{height:72,background:dark?'#272c2d':'#f4f4f0',borderBottom:`1px solid ${dark?'#383e3f':'#e4e5df'}`,display:'flex',alignItems:'center',padding:'0 30px',gap:12,color:dark?'#bfc8c6':'#929992',fontSize:24}}>
 <div style={{display:'flex',gap:10,marginRight:23}}>{['#cccfc9','#cccfc9','#cccfc9'].map((c,i)=><i key={i} style={{width:12,height:12,borderRadius:50,background:c}}/>)}</div>{label}<div style={{marginLeft:'auto',display:'flex',gap:20}}>{children}</div></div>;
}
function Human({f,w,h=1080}:{f:number,w:number,h?:number}){
 const s=Math.min(1,w/950);const left=60*s;const ww=w-left*2;
 const opening=p(f,96,160);const scroll=m(0,480,opening);const drag=p(f,352,400);const yy=m(840,1215,drag)-scroll;
 const cy2=m(1000,840,p(f,405,435))-scroll;
 return <div style={{...abs(0,0,w,h),background:'#fcfcf9',overflow:'hidden'}}>
 <TitleBar label="Notes"/>
 <div style={{...abs(left,140-scroll),fontSize:Math.max(88,128*s),fontWeight:650,letterSpacing:-7,lineHeight:1.08,opacity:1-p(f,90,155)}}>Computers<br/>for your agents<span style={{color:C.orange}}>.</span></div>
 <div style={{...abs(left,600-scroll),fontSize:104*s,fontWeight:650,letterSpacing:-5}}>Today</div>
 <div style={{...abs(left,782-scroll),fontSize:22,color:'#959d90',fontWeight:600,letterSpacing:2}}>TO DO</div>
 {f<405&&<div style={{...abs(left,840-scroll,ww,125),borderRadius:13,background:'#f0f1e9',padding:'33px 24px',color:'#b4b9ae',fontSize:44*s,fontWeight:550}}>Release notes</div>}
 <div style={{...abs(left,cy2,ww,125),borderRadius:13,background:'#f0f1e9',padding:'33px 24px',color:'#748070',fontSize:44*s,fontWeight:550}}>Record demo</div>
 <div style={{...abs(left,1155-scroll),fontSize:22,color:'#929d8e',fontWeight:600,letterSpacing:2}}>DONE</div>
 {drag>0&&<div style={{...abs(left,1215-scroll,ww,125),borderRadius:13,background:'#e9eee4',border:'1px solid #d3ddcc'}}/>}
 <div style={{...abs(left+Math.sin(drag*Math.PI)*9,yy,ww,125),borderRadius:13,background:'#fffefa',border:'1px solid #cbd1c3',boxShadow:drag>0&&drag<1?'0 15px 22px #22332215':undefined,display:'flex',alignItems:'center',padding:'0 24px',gap:20,fontSize:44*s,fontWeight:550}}>{drag>.99&&<Check color={C.green} size={35}/>}Release notes</div>
 {f>=320&&f<768&&<Cursor x={left+ww*.68} y={m(285,840-scroll+62.5,p(f,320,350))+375*drag} scale={1.4}/>} 
 </div>;
}
function Report({f,w,h,local=false,small=false}:{f:number,w:number,h:number,local?:boolean,small?:boolean}){
 const saved=!local&&f>=448;const s=Math.min(1,w/1100);const plotBottom=h-(saved?202:129);const chartTop=310;const barH=Math.max(100,plotBottom-chartTop);const span=(w-116)/3;
 return <div style={{...abs(0,0,w,h),background:'#fffefa',overflow:'hidden'}}>
 <TitleBar label={local?'127.0.0.1:49321':'localhost:3000'}><Minus size={22}/><Square size={20}/></TitleBar>
 <div style={{...abs(54,108),fontWeight:650,fontSize:58*s,letterSpacing:-2}}>Weekly report</div>
 <div style={{...abs(57,193),display:'flex',alignItems:'center',gap:13,fontSize:28*s,color:'#6e796d'}}>Last week <ChevronDown size={22}/></div>
 {[.78,.47,.91].map((v,i)=><React.Fragment key={i}><div style={{...abs(58+i*span,plotBottom-v*barH,span-34,v*barH),background:i===1?'#e5a32d':C.orange,borderRadius:'10px 10px 0 0'}}/><div style={{...abs(65+i*span,plotBottom+15),fontSize:23,color:'#969e90'}}>{['Mon','Wed','Fri'][i]}</div></React.Fragment>)}
 {saved?<div style={{...abs(26,h-154,w-52,130),border:'1px solid #bfcebc',background:'#e5ecdf',borderRadius:13,display:'flex',alignItems:'center',padding:'0 32px',gap:25}}><Check size={43} color={C.green}/><div style={{fontSize:44,fontWeight:580,letterSpacing:-1}}>report.csv</div><div style={{marginLeft:'auto',fontSize:30,color:C.green}}>Saved</div></div>:
 <div style={{...abs(w-328,h-91,275,64),background:C.ink,color:'#fff',borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center',gap:14,fontSize:29,fontWeight:550}}><FileDown size={28}/>Export CSV</div>}
 </div>;
}
function Guest({f,w,h=1080}:{f:number,w:number,h?:number}){
 const grow=p(f,352,398);const margin=m(117,0,grow),top=m(280,166,grow);const bw=w-2*margin,bh=m(660,h-166,grow);
 let x=m(w-290,w-157,p(f,300,350)),y=m(650,316,p(f,300,350));
 if(f>=352){x=m(w-157,w-190.5,p(f,407,430));y=m(316,h-59,p(f,407,430))}if(f>=448){x=w-66;y=h-198}
 return <div style={{...abs(0,0,w,h),background:C.guest}}><Row width={w}/><div style={{...abs(118,202),fontSize:40,fontWeight:550,color:'#e7eee3',opacity:1-grow}}>Export last week’s report.</div><div style={{...abs(margin,top,bw,bh),borderRadius:m(10,0,grow),overflow:'hidden',boxShadow:grow<1?'0 20px 50px #0002':undefined}}><Report f={f} w={bw} h={bh}/></div>{f>=286&&f<1450&&<Cursor x={x} y={y} agent scale={1.9} press={Math.max(0,1-Math.min(Math.abs(f-352),Math.abs(f-432))/5)}/>}</div>;
}
function Hardware({q,kind,amount=1}:{q:Q,kind:'laptop'|'desktop',amount?:number}){
 const [a,b,c,d]=q;const rim=10*amount;const path=(pts:Q)=>pts.map(x=>x.join(',')).join(' ');const mx=(c[0]+d[0])/2,my=(c[1]+d[1])/2;
 return <svg style={{...abs(0,0,1920,1080),overflow:'visible'}}><defs><linearGradient id={'metal'+kind} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#f6f6f3"/><stop offset=".55" stopColor="#c9ceca"/><stop offset="1" stopColor="#989f9a"/></linearGradient></defs>
 <polygon points={path([[a[0]-rim,a[1]-rim],[b[0]+rim,b[1]-rim],[c[0]+rim,c[1]+rim],[d[0]-rim,d[1]+rim]])} fill="#3a413d" stroke="#89918b" strokeWidth={1.5*amount}/>
 {kind==='laptop'?<><polygon points={path([[d[0]-rim,d[1]+rim],[c[0]+rim,c[1]+rim],[c[0]+96*amount,c[1]+95*amount],[d[0]-106*amount,d[1]+95*amount]])} fill={'url(#metal'+kind+')'}/>{[0,1,2,3].map(i=><path key={i} d={`M${d[0]+36-i*13*amount} ${d[1]+(28+i*12)*amount}L${c[0]-36+i*13*amount} ${c[1]+(28+i*12)*amount}`} stroke="#939e95" strokeWidth={3*amount}/>)}</>:
 <><path d={`M${mx-31} ${my+10}L${mx+31} ${my+10}L${mx+47} ${my+98*amount}L${mx-47} ${my+98*amount}Z`} fill={'url(#metal'+kind+')'}/><rect x={mx-118} y={my+92*amount} width="236" height={12*amount} rx={5} fill="#a2ada4"/><rect x={c[0]-112} y={c[1]+64*amount} width="155" height={47*amount} rx={10*amount} fill="#c9d0c9" stroke="#a7b1a8"/><circle cx={c[0]+20} cy={c[1]+87*amount} r={3} fill={C.green}/></>}
 </svg>;
}
function Terminal({f,w,h}:{f:number,w:number,h:number}){
 const typed=p(f,896,934);const command='curl -I localhost:3000';
 return <div style={{...abs(0,0,w,h),background:'#202825',color:'#e8eee6'}}><Row width={w} mode="access"/><div style={{...abs(0,166,w,75),borderBottom:'1px solid #3c4840',padding:'10px 40px',fontSize:42,color:'#a0b39f',fontFamily:mono}}>studio <span style={{color:'#687e69'}}>— SSH</span></div><div style={{...abs(56,320),fontFamily:mono,fontSize:58,lineHeight:1.8}}><div style={{color:'#9bb593'}}>silo@studio <span style={{color:'#d0dcca'}}>~</span></div><div style={{marginTop:24,color:'#f2f4ed'}}><span style={{color:C.orange}}>$ </span>{command.slice(0,Math.round(command.length*typed))}<span style={{opacity:f<944?1:0}}>▍</span></div>{f>=944&&<div style={{marginTop:39,color:'#afcea4'}}>HTTP/1.1 <span style={{color:'#e7f2dc'}}>200 OK</span></div>}</div></div>;
}
function Network({f,w,h}:{f:number,w:number,h:number}){
 const connected=f>=1152;const sc=3.25;
 return <div style={{...abs(0,0,w,h),background:'#fff'}}><Row width={w} mode="access"/><div style={{...abs(60,227),fontWeight:650,fontSize:62,letterSpacing:-2}}>Network</div><div style={{...abs(60,334,w-120,346),border:'2px solid #e1e4dc',borderRadius:15,overflow:'hidden'}}>
 <div style={{height:78,background:'#f7f8f3',display:'flex',alignItems:'center',padding:'0 34px',gap:60,fontSize:25,color:'#898e84'}}><span style={{width:140}}>Port</span><span>Local address</span></div>
 <div style={{display:'flex',alignItems:'center',padding:'41px 34px',gap:48}}><div style={{width:154,height:96,flexShrink:0}}/><div style={{fontSize:52,fontFamily:mono,color:connected?'#242b23':'#a9afa2'}}>{connected?'127.0.0.1:49321':'—'}</div><div style={{marginLeft:'auto',transform:`scale(${sc})`,transformOrigin:'right center'}}><Button variant="ghost" size="icon-xs" aria-label={connected?'Open local browser':'Connect port'}>{connected?<ExternalLink/>:<Plus/>}</Button></div></div>
 <div style={{position:'absolute',left:36,bottom:30,display:'flex',alignItems:'center',gap:34}}><div style={{transform:'scale(2.5)',transformOrigin:'left center',width:260}}><WorkspaceBadge name="studio" state="running" computer={office}/></div><span style={{fontSize:29,color:connected?C.green:'#888e83'}}>{connected?'Reachable':''}</span></div>
 </div>{f>=1088&&<div style={{...abs(96,455),fontSize:64,fontFamily:mono,lineHeight:'96px'}}>3000</div>}<Cursor x={w-135} y={503} scale={1.8} opacity={f>=1088?1:0}/></div>;
}
export function Film(){
 const f=useCurrentFrame();
 const open=p(f,256,352),own=p(f,544,704),access=p(f,768,864),localResult=p(f,1248,1344),returnView=p(f,1408,1504),close=p(f,1568,1664);
 const hw=m(1920,550,open),lh=m(1080,1000,own),gh=m(1080,1000,own);
 let lw=m(hw,1600,own),nw=m(hw,1000,own),gw=m(m(808,1370,open),1600,own);
 let lq=qmix([[0,0],[hw,0],[hw,1080],[0,1080]],[[125,370],[880,330],[885,845],[145,885]],own);
 let gq=qmix([[550,0],[1920,0],[1920,1080],[550,1080]],[[1040,318],[1780,350],[1780,818],[1040,780]],own);
 lq=qmix(lq,[[75,93],[1440,93],[1440,980],[75,980]],access);
 gq=qmix(gq,[[1480,625],[1860,642],[1860,880],[1480,862]],access);
 lq=qmix(lq,[[125,315],[1190,350],[1190,930],[145,903]],returnView);
 gq=qmix(gq,[[1370,481],[1840,505],[1840,799],[1370,773]],returnView);
 lq=lq.map(([x,y])=>[x-2180*close,y]);gq=gq.map(([x,y])=>[x+1700*close,y]);
 if(own>0 && f<768){const edge=(q:Q)=>((Math.hypot(q[1][0]-q[0][0],q[1][1]-q[0][1])+Math.hypot(q[2][0]-q[3][0],q[2][1]-q[3][1]))/2)/((Math.hypot(q[3][0]-q[0][0],q[3][1]-q[0][1])+Math.hypot(q[2][0]-q[1][0],q[2][1]-q[1][1]))/2);lw=edge(lq)*lh;nw=Math.min(lw,1000);gw=edge(gq)*gh;}
 const localHardware=own*(1-access)+returnView;const guestHardware=own;
 const state=f<176?'stopped':f<224?'starting':'running';
 let localContent:React.ReactNode=<div style={{...abs(0,0,lw,lh),background:'#e4e9dd'}}><Human f={f} w={nw} h={lh}/>{lw>nw+160&&<div style={{...abs(nw+24,29,lw-nw-47,330),background:'#fff',borderRadius:12,padding:'29px 22px',overflow:'hidden'}}><div style={{display:'flex',alignItems:'center',gap:17,fontSize:36,fontWeight:650,marginBottom:44}}><SiloMark data-film-mark style={{width:40,height:40}}/>Silo</div><div style={{fontSize:34,fontWeight:600,marginBottom:16}}>studio</div><div style={{transform:'scale(2)',transformOrigin:'left top',width:150}}><WorkspaceStatus state="running"/></div><div style={{marginTop:48,fontSize:24,color:'#778171'}}>Office Mac</div></div>}</div>;
 if(f>=768){
  const termOpen=p(f,768,864),net=f>=1087?1:p(f,992,1088);
  const previous=localContent,tx=m(1015,0,termOpen),ty=m(181,0,termOpen),tw=m(510,1600,termOpen),th=m(166,1000,termOpen);
  localContent=<div style={{...abs(0,0,1600,1000),background:'#fff'}}>
  {previous}
  <div style={{...abs(tx,ty,tw,th),overflow:'hidden',boxShadow:'0 6px 30px #0002'}}><Terminal f={f} w={tw} h={th}/></div>
  {f>=992&&<div style={{...abs(0,0,1600,1000),clipPath:`inset(${m(408,0,net)}px ${m(720,0,net)}px ${m(500,0,net)}px ${m(294,0,net)}px round ${m(9,0,net)}px)`}}><Network f={f} w={1600} h={1000}/></div>}
  {f>=992&&f<1088&&<div style={{...abs(m(754.8,96,net),m(448.4,455,net)),fontFamily:mono,fontSize:m(58,64,net),lineHeight:`${m(104.4,96,net)}px`,background:'#fff',padding:0,borderRadius:6,color:C.ink}}>3000</div>}
  {f>=1248&&<div style={{...abs(0,m(845,0,localResult),1600,1000),boxShadow:'0 -12px 40px #0001'}}><Report f={f} w={1600} h={1000} local/></div>}
  </div>;
 }
 return <AbsoluteFill style={{background:'radial-gradient(ellipse at 40% 35%,#fbfaf5 0%,#efeee7 90%)',overflow:'hidden'}}>
 {/* The final lockup is revealed by the same two workspace edges parting. */}
 <div style={{...abs(0,0,1920,1080),display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',opacity:p(f,1575,1650),transform:`translateY(${m(35,0,p(f,1580,1664))}px)`}}>
 <div style={{display:'flex',alignItems:'center',gap:32,marginBottom:49}}><SiloMark data-film-mark style={{width:132,height:132}}/><div style={{fontSize:140,lineHeight:1,fontWeight:620,letterSpacing:-8}}>Silo</div></div>
 <div style={{fontSize:74,fontWeight:520,letterSpacing:-3.6}}>Computers for your agents</div><div style={{fontSize:38,color:'#777c71',marginTop:60,letterSpacing:-.5}}>silo.polarzero.xyz</div>
 </div>
 {own>0&&<><div style={{...abs(90,903,1000,84),borderRadius:'50%',background:'#3e4e3225',filter:'blur(30px)',opacity:(1-access+returnView)*(1-close)}}/><div style={{...abs(1250,904,620,80),borderRadius:'50%',background:'#3e4e3220',filter:'blur(28px)',opacity:(1-close)}}/></>}
 {localHardware>0&&<Hardware q={lq} kind="laptop" amount={localHardware}/>} {guestHardware>0&&<Hardware q={gq} kind="desktop" amount={guestHardware}/>} 
 <Surface q={lq} w={f>=768?1600:lw} h={f>=768?1000:lh}>{localContent}</Surface>
 {open<1?<>
 <div style={{...abs(m(1060,550,open),m(714,-107,open)),opacity:1-p(f,256,296),display:'flex',gap:18,alignItems:'center',fontSize:39,fontWeight:650}}><SiloMark data-film-mark style={{width:43,height:43}}/>Silo</div>
 <div style={{...abs(m(1060,550,open),m(790,0,open),gw,m(166,1080,open)),overflow:'hidden',background:C.guest,boxShadow:'0 2px 0 #0001'}}>
 {f>=256?<Guest f={f} w={gw}/>:<Row width={gw} state={state}/>}
 </div>
 {f>=136&&f<244&&<Cursor x={m(1460,1723.1,p(f,136,172))} y={m(705,865.6,p(f,136,172))} scale={1.65} press={1-Math.abs(f-176)/7>0?1-Math.abs(f-176)/7:0}/>}
 </>:<Surface q={gq} w={gw} h={gh}><Guest f={f} w={gw} h={gh}/></Surface>}
 </AbsoluteFill>;
}

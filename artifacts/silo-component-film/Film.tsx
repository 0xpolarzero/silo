import React from 'react';
import {AbsoluteFill, Composition, Img, staticFile, registerRoot, useCurrentFrame, useVideoConfig} from 'remotion';
import {CameraMotionBlur} from '@remotion/motion-blur';
import {Terminal, Code2, Play, Square, RotateCcw, Monitor, ArrowUpRight, Check, ChevronRight, Globe, LockKeyhole, Folder, GitBranch, Network, MousePointer2} from 'lucide-react';
import {SiloMark} from '@/components/silo-mark';
import {SandboxList, SandboxListItem, SandboxListRow, SandboxAction} from '@/features/sandboxes/components/sandbox-list';
import {ComputerBadge} from '@/features/sandboxes/components/computer-badge';
import {WorkspaceStatus} from '@/features/application/components/application-ui';
import {NetworkPage} from '@/features/application/pages/network-page';
import {Button} from '@/components/ui/button';
import {applicationSourceForScenario} from '@/fixtures/application-scenarios';
import {workspaceTarget} from '@/features/application/model/remote-computers';
import {machineSummary} from '@/features/sandboxes/model/machine-summary';
import './film.css';

const C={paper:'#f3f1e9',ink:'#171b18',orange:'#ff9f0a',green:'#357455',muted:'#788078',line:'#d9dcd3'};
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const ease=(p:number)=>{p=clamp(p);return p<.5?16*p**5:1-(-2*p+2)**5/2};
const out=(p:number)=>1-(1-clamp(p))**4;
const p=(t:number,a:number,b:number)=>clamp((t-a)/(b-a));
const e=(t:number,a:number,b:number)=>ease(p(t,a,b));
const lerp=(a:number,b:number,x:number)=>a+(b-a)*x;
const opacity=(t:number,a:number,b:number,c=999,d=1000)=>out(p(t,a,b))*(1-e(t,c,d));
type Rect={x:number;y:number;w:number;h:number};
const APP_RECT:Rect={x:140,y:125,w:1640,h:830};
const WORKSPACE_HANDOFF=9.2;
const mixRect=(a:Rect,b:Rect,n:number):Rect=>({x:lerp(a.x,b.x,n),y:lerp(a.y,b.y,n),w:lerp(a.w,b.w,n),h:lerp(a.h,b.h,n)});
const pos=(r:Rect):React.CSSProperties=>({position:'absolute',left:r.x,top:r.y,width:r.w,height:r.h});
const small={fontSize:19,fontWeight:600,letterSpacing:2,textTransform:'uppercase' as const};
const none=()=>{};
const computer={id:'office',vmId:'your-app',name:'Office computer',address:'office.local',connected:true};
const base=applicationSourceForScenario('running').workspaces[0];
const workspace={...base,machine:{...base.machine,id:'your-app',name:'your-app'},state:'running' as const,freshness:'fresh' as const,computer};

function Mark({size=48,color=C.ink}:{size?:number;color?:string}){return <SiloMark style={{width:size,height:size,color}}/>}
function Label({children,x,y,color=C.muted}:{children:React.ReactNode;x:number;y:number;color?:string}){return <div style={{position:'absolute',left:x,top:y,...small,color}}>{children}</div>}
function Dots(){return <div style={{display:'flex',gap:7}}>{['#e0a69c','#dfc17b','#a9c2a2'].map(c=><i key={c} style={{display:'block',width:10,height:10,borderRadius:10,background:c}}/>)}</div>}
function Cursor({x,y,show=1,press=0}:{x:number;y:number;show?:number;press?:number}){return <div style={{position:'absolute',left:x,top:y,opacity:show,transform:`scale(${1-press*.15})`,filter:'drop-shadow(0 3px 3px #0004)',zIndex:30}}><svg width="40" height="47" viewBox="0 0 40 47"><path d="M4 3v32l9-8 8 16 7-4-8-15 12-2Z" fill="white" stroke={C.ink} strokeWidth="2.5" strokeLinejoin="round"/></svg>{press>0&&<div style={{position:'absolute',left:-15,top:-15,width:42,height:42,border:'2px solid #ff9f0a',borderRadius:50,opacity:press}}/>}</div>}
function AgentCursor({x,y,show=1,press=0,travel=0}:{x:number;y:number;show?:number;press?:number;travel?:number}){
 const scale=1.8,tilt=27*Math.sin(travel*Math.PI),stretch=1-.12*Math.sin(travel*Math.PI);
 return <div style={{position:'absolute',left:x-12*scale,top:y-12*scale,width:24,height:24,transform:`scale(${scale})`,transformOrigin:'0 0',zIndex:30,pointerEvents:'none'}}>
  <div style={{width:24,height:24,opacity:show,transformOrigin:'12px 12px',transform:`rotate(${-44+tilt}deg) scale(${stretch*lerp(.4,1,show)*(1-press*.08)},${lerp(.4,1,show)*(1-press*.08)})`,filter:`blur(${5*(1-show)}px)`}}>
   <div style={{transform:'translate3d(12px,-2.5px,0)'}}><Img src={staticFile('codex-agent-cursor.png')} width={23} height={24} style={{display:'block',transform:'rotate(44deg)',transformOrigin:'0 0',filter:'drop-shadow(0 0 6px #339cffe6) drop-shadow(0 0 15px #339cff7a)'}}/></div>
  </div>
 </div>
}
function Pill({children,active=false}:{children:React.ReactNode;active?:boolean}){return <span style={{display:'inline-flex',alignItems:'center',gap:8,padding:'8px 14px',borderRadius:24,background:active?'#e5efe6':'#eeeee8',color:active?C.green:C.muted,fontSize:18,fontWeight:550}}>{children}</span>}

function NativeRow({running=true,large=false}:{running?:boolean;large?:boolean}){
 return <div className="native-ui" style={{width:760}}><SandboxList label="Sandboxes"><SandboxListItem><SandboxListRow name="your-app" kind="vm" remote kindBadge={<ComputerBadge computer={computer}/>} tone={running?'running':'stopped'} detail={<span style={{display:'flex',gap:12,alignItems:'center'}}><WorkspaceStatus state={running?'running':'stopped'}/><span>{machineSummary(workspace.machine)}</span></span>} actions={<><SandboxAction label="Open your-app in Terminal"><Terminal/></SandboxAction><SandboxAction label="Open your-app in editor"><Code2/></SandboxAction><SandboxAction label="Open Linux desktop"><Monitor/></SandboxAction><SandboxAction label={running?'Stop your-app':'Start your-app'}>{running?<Square/>:<Play/>}</SandboxAction><SandboxAction label="Restart your-app"><RotateCcw/></SandboxAction></>}/></SandboxListItem></SandboxList></div>
}

function NativeNetwork({connected=false}:{connected?:boolean}){
 const actions={openNetworkPort:async()=>{},saveNetworkPort:async()=>{},removeNetworkPort:async()=>{}} as any;
 const network={workspaces:[{workspace:workspaceTarget(workspace),error:null,ports:[{port:3000,hostPort:connected?51432:null,scheme:'http' as const,state:connected?'reachable' as const:'unpublished' as const,configured:connected}]}]};
 return <div className="native-ui film-network" style={{width:760}}><NetworkPage workspaces={[workspace]} browser="Browser" network={network} actions={actions} active={false}/></div>
}

function ProductWindow({rect,t,network=false,connected=false,rows=true}:{rect:Rect;t:number;network?:boolean;connected?:boolean;rows?:boolean}){
 const scale=rect.w/840;
 return <div style={{...pos(rect),borderRadius:22,overflow:'hidden',background:'white',boxShadow:'0 26px 80px #1722181b',border:'1px solid #d2d5cd'}}>
  <div style={{position:'absolute',left:0,top:0,width:840,height:rect.h/scale,transform:`scale(${scale})`,transformOrigin:'0 0'}}>
   <div style={{height:43,display:'flex',alignItems:'center',padding:'0 18px',gap:18,borderBottom:'1px solid #e9eae5',background:'#fafbf8'}}><Dots/><div style={{display:'flex',alignItems:'center',gap:7,fontSize:12,fontWeight:650}}><Mark size={21}/>Silo</div><span style={{marginLeft:'auto',fontSize:11,color:C.muted}}>your-app <span style={{padding:'0 9px',color:'#bac0b9'}}>/</span> Office computer</span></div>
   <div style={{padding:'21px 40px'}}>
    <div style={{display:'flex',alignItems:'center',marginBottom:16,gap:13,fontSize:13,color:C.muted}}><span style={{fontWeight:600,color:C.ink}}>Sandboxes</span><ChevronRight size={12}/><span>{network?'Network':'Overview'}</span></div>
    {rows&&<NativeRow running={t>=6.55}/>}
    {network?<div style={{marginTop:26}}><NativeNetwork connected={connected}/></div>:<div style={{marginTop:26,opacity:1-e(t,7.9,8.55)}}><div style={{display:'flex',gap:16}}>{[[GitBranch,'Repositories','your-app'],[LockKeyhole,'Secrets','Scoped access']].map(([Icon,title,desc]:any)=><div key={title} style={{border:'1px solid #e4e7de',borderRadius:9,width:370,padding:18}}><Icon size={17}/><div style={{fontSize:12,fontWeight:600,marginTop:11}}>{title}</div><div style={{fontSize:11,color:C.muted,marginTop:5}}>{desc}</div></div>)}</div></div>}
   </div>
  </div>
 </div>
}

function Office({x=1420,y=552,scale=1,run=false,alpha=1}:{x?:number;y?:number;scale?:number;run?:boolean;alpha?:number}){
 return <div style={{position:'absolute',left:x,top:y,opacity:alpha,transform:`scale(${scale})`,transformOrigin:'50% 50%'}}>
  <svg width="290" height="248" viewBox="0 0 290 248"><defs><linearGradient id="metal" x2="0" y2="1"><stop stopColor="#e6e8df"/><stop offset="1" stopColor="#bbc2b8"/></linearGradient></defs><ellipse cx="143" cy="218" rx="126" ry="20" fill="#172218" opacity=".09"/><path d="M19 79 127 18q14-8 29 0l112 63v92q0 10-10 15l-106 56q-10 4-22-2L27 186q-8-5-8-15Z" fill="url(#metal)"/><path d="m20 80 120 66 128-65M140 146v98" fill="none" stroke="#a9b2a6" strokeWidth="2"/><path d="m72 65 58-33q9-5 18 0l65 36-66 36q-6 3-11 0Z" fill="#dde2d7" stroke="#a9b2a6"/><circle cx="239" cy="166" r="4" fill={run?C.green:'#778276'}/><path d="M44 147v14m12-8v14" stroke="#84917d" strokeWidth="4" strokeLinecap="round"/></svg>
  <div style={{position:'absolute',left:81,top:53,transform:'rotate(-30deg) skewX(30deg) scaleY(.85)'}}><Mark size={72}/></div>
  {run&&<div style={{position:'absolute',left:38,top:-80,background:C.ink,color:'white',padding:'13px 20px',borderRadius:13,fontSize:24,display:'flex',gap:12,alignItems:'center'}}><span style={{width:10,height:10,borderRadius:20,background:C.orange}}/>your-app</div>}
 </div>
}

function Wire({progress=1,pulse=0}:{progress?:number;pulse?:number}){return <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}><path d="M1070 662H1260q50 0 50 50v50q0 35 35 35h96" fill="none" stroke="#bfc7bb" strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>{pulse>0&&pulse<1&&<path d="M1070 662H1260q50 0 50 50v50q0 35 35 35h96" fill="none" stroke={C.orange} strokeWidth="13" strokeLinecap="round" pathLength="1" strokeDasharray=".012 .988" strokeDashoffset={1-pulse}/>}</svg>}

function TerminalPane({rect,t,stage='code'}:{rect:Rect;t:number;stage?:string}){
 const typeText='npm run dev -- --host 0.0.0.0';
 const count=Math.floor(p(t,11.0,12.0)*typeText.length);
 return <div style={{...pos(rect),borderRadius:19,background:'#18201d',color:'#e8efe6',overflow:'hidden',boxShadow:'0 18px 44px #18201d20'}}>
  <div style={{height:55,padding:'0 23px',display:'flex',alignItems:'center',gap:20,borderBottom:'1px solid #ffffff15',background:'#202a25'}}><Dots/><Terminal size={20}/><span style={{fontSize:18,color:'#b9c7bc'}}>your-app <span style={{color:'#7f9585'}}>— SSH</span></span></div>
  <div className="mono" style={{padding:27,fontSize:24,lineHeight:1.65}}><div style={{color:'#91a393',fontSize:19}}>Connected to your-app · Office computer</div><div style={{marginTop:24}}><span style={{color:'#9bc8a2'}}>~/your-app</span> <span style={{color:C.orange}}>❯</span></div><div>{typeText.slice(0,count)}<span style={{display:'inline-block',width:13,height:28,background:'#9bb79e',verticalAlign:'middle',opacity:t<12?1:0}}/></div><div style={{opacity:out(p(t,12.1,12.35)),position:'absolute',left:27,top:245}}><span style={{color:'#9ec8a6'}}>✓</span> Ready in 284 ms<div style={{marginTop:7.4,color:'#c6d4c7'}}>Server <span style={{color:C.orange}}>http://0.0.0.0:</span></div></div></div>
 </div>
}

function EditorPane({rect,alpha=1}:{rect:Rect;alpha?:number}){
 const code=[['import',' { Checkout } ','from'," './checkout'"],[''],['export default function',' App() {'],['  return',' ('],['    <Checkout'],['      product=', '"Studio lamp"'],['      price=', '{89}'],['      currency=', '"EUR"'],['    />'],['  )'],['}']];
 return <div style={{...pos(rect),opacity:alpha,border:'1px solid #dce0d6',borderRadius:18,overflow:'hidden',background:'#fcfdf9',boxShadow:'0 20px 50px #18201d15'}}><div style={{height:55,display:'flex',alignItems:'center',padding:'0 24px',gap:14,borderBottom:'1px solid #e6e9e0',fontSize:18,color:C.muted}}><Code2 size={21}/> your-app <span style={{marginLeft:'auto'}}>App.tsx</span></div><div className="mono" style={{padding:'24px 14px',fontSize:19,lineHeight:1.58,whiteSpace:'pre'}}>{code.map((line,i)=><div key={i} style={{display:'flex'}}><span style={{color:'#b4bcb0',fontSize:15,width:34,textAlign:'right',marginRight:20}}>{i+1}</span><span>{line.map((s,j)=><span key={j} style={{color:j===0?'#5d795d':j===1?'#9d6419':C.ink}}>{s}</span>)}</span></div>)}</div></div>
}

function Lamp({scale=1}:{scale?:number}){return <svg width="440" height="440" viewBox="0 0 440 440" style={{transform:`scale(${scale})`}}><defs><linearGradient id="shade" x1="0" x2="1"><stop stopColor="#bc4d2b"/><stop offset=".45" stopColor="#ed8a56"/><stop offset="1" stopColor="#ae4326"/></linearGradient></defs><ellipse cx="228" cy="375" rx="127" ry="15" fill="#924526" opacity=".12"/><path d="M212 170h25v174h-25z" fill="#973c22"/><ellipse cx="224" cy="344" rx="91" ry="22" fill="#cc6639"/><ellipse cx="224" cy="337" rx="88" ry="18" fill="#e08550"/><path d="M89 177c10-91 56-135 137-135s123 45 136 135q-134 55-273 0" fill="url(#shade)"/><ellipse cx="226" cy="177" rx="137" ry="32" fill="#ae492a"/><ellipse cx="225" cy="181" rx="112" ry="17" fill="#ffc37d"/><path d="M191 58c-43 13-66 44-78 90" fill="none" stroke="#ffbd80" strokeWidth="8" opacity=".28" strokeLinecap="round"/></svg>}

function WebApp({success=false,unit=1}:{success?:boolean;unit?:number}){
 return <div style={{width:'100%',height:'100%',background:'#f9f7f0',position:'relative',padding:'3.7% 5%'}}>
  <div style={{fontSize:28*unit,fontWeight:650,letterSpacing:-1}}>form<span style={{color:'#bb6039'}}>.</span><span style={{float:'right',fontSize:17*unit,fontWeight:400,letterSpacing:0,color:'#798275'}}>Objects for everyday.</span></div>
  <div style={{display:'flex',alignItems:'center',height:'84%',gap:'6%'}}><div style={{width:'48%',height:'85%',background:'#eadfcf',borderRadius:9,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}><Lamp scale={.9*unit}/></div><div style={{flex:1}}><div style={{...small,fontSize:14*unit,color:'#a17355'}}>Made for slow evenings</div><div style={{fontFamily:'Georgia,serif',fontSize:57*unit,lineHeight:1.13,letterSpacing:-2,marginTop:17}}>Studio<br/>lamp.</div><p style={{fontSize:20*unit,color:'#74806f',marginTop:19,lineHeight:1.6}}>Warm light.<br/>A little room to think.</p><div style={{fontSize:29*unit,marginTop:16}}>€89</div><div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,marginTop:22,padding:`${18*unit}px ${16*unit}px`,background:success?'#38604b':'#252e26',color:'#fff',borderRadius:6,fontSize:20*unit}}>{success?<><Check size={22}/> Order confirmed</>:'Buy now'}</div></div></div>
 </div>
}

function BrowserPane({rect,success=false,guest=false,launch=1}:{rect:Rect;success?:boolean;guest?:boolean;launch?:number}){
 const header=lerp(82,62,launch),fontSize=lerp(23.88,lerp(16,21,clamp((rect.w-832)/620)),launch);
 return <div style={{...pos(rect),border:'1px solid #d7dbd1',borderRadius:lerp(12,20,launch),overflow:'hidden',background:'#fff',boxShadow:`0 ${25*launch}px ${75*launch}px #1722181a`}}>
  <div style={{height:header,position:'relative',display:'flex',alignItems:'center',padding:'0 24px',gap:26,background:'#fcfdf9',borderBottom:'1px solid #e4e8de'}}>
   <div style={{opacity:launch}}><Dots/></div><div style={{height:35,borderRadius:8,background:'#eff2e9',flex:1,opacity:launch}}/><ArrowUpRight size={20} color={C.muted} style={{opacity:launch}}/>
   <div className="mono" style={{position:'absolute',left:lerp(241,rect.w/2+12,launch),top:(header-32)/2,transform:`translateX(${-50*launch}%)`,display:'flex',alignItems:'center',height:32,fontSize,color:`color-mix(in srgb,#747474 ${100*(1-launch)}%,#52614e)`,whiteSpace:'nowrap'}}><span style={{display:'flex',width:27*launch,overflow:'hidden',opacity:launch}}><Globe size={16}/></span><span style={{width:fontSize*.602*7*(1-e(launch,.15,.65)),overflow:'hidden',opacity:1-e(launch,0,.12)}}>http://</span>{guest?'localhost:3000':'127.0.0.1:51432'}</div>
  </div>
  <div style={{height:Math.max(0,rect.h-header),overflow:'hidden'}}><div style={{height:Math.max(560,rect.h-header)}}><WebApp success={success} unit={lerp(.74,1,clamp((rect.w-832)/620))}/></div></div>
 </div>
}

function Intro({t}:{t:number}){
 const exit=e(t,3.1,4.05), rows=[['COMPUTERS',0],['FOR YOUR',.54],['AGENTS.',.96]] as const;
 return <div style={{position:'absolute',inset:0,transform:`translateY(${-1100*exit}px)`,opacity:1-e(t,3.7,4.05)}}>
  <div style={{position:'absolute',left:139,top:106,display:'flex',alignItems:'center',gap:14,opacity:.4+.6*out(p(t,0,.3))}}><Mark size={38}/><span style={{fontSize:25,fontWeight:650}}>Silo</span></div>
  {rows.map(([word,a],i)=><div key={word} style={{position:'absolute',left:128,top:190+i*212,width:1664,height:262,paddingTop:24,overflow:i===0?'visible':'hidden'}}><div className="display" style={{fontSize:234,color:i===2?C.orange:C.ink,transform:i===0?`scale(${1+.18*(1-out(p(t,a,a+.56)))})`:`translateY(${(1-out(p(t,a,a+.56)))*264}px)`,transformOrigin:'0 50%'}}>{word}</div></div>)}
  <div style={{position:'absolute',left:141,top:935,fontSize:25,color:C.muted,opacity:opacity(t,1.65,2.05)}}>Linux VMs. On your computers.</div>
  <div style={{position:'absolute',right:139,top:437,width:246,height:246,transform:`rotate(${lerp(-80,0,out(p(t,1,2.15)))}deg) scale(${out(p(t,1,1.9))})`}}><Mark size={246}/></div>

 </div>
}

function Remote({t}:{t:number}){
 const push=e(t,7.9,WORKSPACE_HANDOFF);const r=mixRect({x:132,y:396,w:925,h:510},APP_RECT,push);
 const show=out(p(t,3.45,4.15));const run=t>=6.55;
 return <div style={{position:'absolute',inset:0,opacity:show}}>
  <div style={{opacity:1-push}}><div className="display" style={{position:'absolute',left:132,top:172,fontSize:108,transform:`translateY(${35*(1-show)}px)`}}>Start it here.</div><div className="display" style={{position:'absolute',left:1245,top:342,fontSize:94}}>Run it<br/><span style={{color:'#cd7800'}}>there.</span></div><Label x={136} y={976}>Your laptop</Label><Label x={1384} y={868}>Office computer</Label><Office run={run}/><Wire progress={out(p(t,4.65,5.5))} pulse={p(t,6.08,6.55)}/></div>
  <ProductWindow rect={r} t={t}/>
  <div style={{position:'absolute',left:r.x-30*(1-push),top:r.y+r.h-1,width:r.w+60*(1-push),height:24*(1-push),background:'#b9c1b4',borderRadius:'0 0 35px 35px',opacity:1-push}}/>
  <div style={{position:'absolute',left:r.x+r.w*.39,top:r.y+r.h,width:r.w*.22,height:8,background:'#8e9b86',borderRadius:'0 0 10px 10px',opacity:1-push}}/>
  {t<7.5&&<Cursor x={lerp(921,962,e(t,5.3,6.0))} y={lerp(692,537,e(t,5.3,6.0))} show={opacity(t,5.1,5.4,6.9,7.3)} press={Math.sin(Math.PI*p(t,6.04,6.28))}/>}
 </div>
}

function Workflow({t}:{t:number}){
 const enter=e(t,9.55,10.3);const edit=e(t,10.5,11.1);const toNet=e(t,14.55,15.65);const toBrowser=e(t,19.85,21.15);const toDesktop=e(t,23.1,24.45);const finish=e(t,29.6,31.0);
 const bgRect=APP_RECT;
 const terminalRect=mixRect({x:1433,y:350,w:50,h:50},{x:202,y:467,w:854,h:435},enter);
 const codeRect=mixRect({x:1485,y:350,w:50,h:50},{x:1082,y:467,w:632,h:435},edit);
 const browserStart={x:202,y:596,w:1512,h:82};
 const browserHero=APP_RECT;
 const guestRect={x:850,y:265,w:832,h:650};
 const browserRect=mixRect(mixRect(browserStart,browserHero,toBrowser),guestRect,toDesktop);
 const uiFade=1-toBrowser; const retreat=e(t,29.6,30.5);
 return <div style={{position:'absolute',left:0,top:0,width:1920,height:1080,transform:`translate(${475*retreat}px,${235*retreat}px) scale(${lerp(1,.505,retreat)})`,transformOrigin:'0 0',borderRadius:28*retreat,overflow:'hidden',boxShadow:retreat>0?'0 24px 70px #17221824':undefined,opacity:1-e(t,30.95,31.3)}}>
  <div><ProductWindow rect={bgRect} t={t} network={false}/></div>
  
  <div style={{position:'absolute',inset:0,clipPath:'inset(315px 200px 150px 200px)',visibility:t>15.4?'hidden':'visible'}}><div style={{opacity:out(p(t,9.55,9.8)),transform:`translateX(${-1050*e(t,14.55,15.4)}px)`}}><TerminalPane rect={terminalRect} t={t}/></div><div style={{opacity:out(p(t,10.5,10.75)),transform:`translateX(${790*e(t,14.65,15.4)}px)`}}><EditorPane rect={codeRect}/></div></div>
  <div style={{position:'absolute',left:1305,top:418,opacity:opacity(t,9.2,9.45,9.7,9.9),background:C.ink,color:'white',borderRadius:8,padding:'9px 15px',fontSize:20}}>Open in your terminal</div>
  <div style={{position:'absolute',inset:0,clipPath:'inset(445px 200px 140px 200px)',visibility:t<15.05?'hidden':'visible'}}><div style={{opacity:uiFade,position:'absolute',inset:0,transform:`translateY(${460*(1-e(t,15.05,15.95))}px)`}}>
   
   <div style={{position:'absolute',left:202,top:450,transform:'scale(1.99)',transformOrigin:'0 0'}}><NativeNetwork connected={t>=18.35}/></div>
   <div style={{position:'absolute',left:222,top:735,display:'flex',alignItems:'center',gap:23,opacity:1-e(t,19.7,20.15)}}>
    <div style={{color:C.muted,fontSize:21}}>Server in your VM</div><ChevronRight size={23} color={C.muted}/><div className="mono" style={{fontSize:33,fontWeight:500}}>3000</div><div style={{width:117,height:2,background:C.orange,transform:`scaleX(${e(t,18.25,18.65)})`,transformOrigin:'left'}}/><div style={{opacity:e(t,18.35,18.7)}}><div className="mono" style={{fontSize:33}}>127.0.0.1:51432</div><div style={{fontSize:20,color:C.muted,marginTop:8}}>Now on your laptop</div></div>
   </div>
   <div style={{position:'absolute',left:227,top:851,fontSize:19,color:C.muted,opacity:opacity(t,16,16.4,18.1,18.4)}}>Connect to this computer</div>
  </div>
  </div>
  {t>=12.1&&t<21.15&&(()=>{const first=e(t,14.55,15.17),last=e(t,15.17,16.1);const x=lerp(lerp(547,723,first),228,last),y=lerp(lerp(759,508,first),621,last),size=lerp(lerp(24,185,first),23.88,last);return <div className="mono" style={{position:'absolute',left:x,top:y,fontSize:size,lineHeight:lerp(1.65,4/3,last),fontWeight:lerp(400,500,last),color:`rgb(${Math.round(lerp(255,23,last))},${Math.round(lerp(159,27,last))},${Math.round(lerp(10,24,last))})`,opacity:out(p(t,12.1,12.35))*uiFade,pointerEvents:'none'}}>3000</div>})()}
  {t<15&&<Cursor x={t<10?lerp(1530,1458,e(t,9.12,9.42)):lerp(1458,1510,e(t,10.1,10.4))} y={t<10?lerp(520,373,e(t,9.12,9.42)):373} show={opacity(t,9.05,9.3,10.8,11.05)} press={t<10?Math.sin(Math.PI*p(t,9.5,9.75)):Math.sin(Math.PI*p(t,10.45,10.7))}/>}
  {t>=16.7&&t<20.2&&<Cursor x={t<18.75?lerp(1720,1662,e(t,16.8,17.65)):lerp(1662,1497,e(t,18.9,19.5))} y={t<18.75?lerp(816,636,e(t,16.8,17.65)):636} show={opacity(t,16.7,17,19.9,20.15)} press={t<18.75?Math.sin(Math.PI*p(t,18.1,18.4)):Math.sin(Math.PI*p(t,19.6,19.85))}/>}

  <div style={{position:'absolute',inset:0,clipPath:`inset(0 ${(1-toDesktop)*100}% 0 0)`}}>
   <div style={{position:'absolute',inset:0,background:'#24342b'}}/>
   <div style={{position:'absolute',left:133,top:102,color:'#f1f4ea',display:'flex',gap:14,alignItems:'center'}}><Mark size={43} color="#f1f4ea"/><div style={{fontSize:30}}>your-app <span style={{color:'#9fae9d'}}> / Linux desktop</span></div></div>
   <div style={{position:'absolute',right:132,top:112,color:'#b5c3b4',fontSize:19,display:'flex',alignItems:'center',gap:11}}><span style={{width:8,height:8,borderRadius:10,background:C.orange}}/>Office computer</div>
   <div style={{position:'absolute',left:134,top:270,width:647,height:640,background:'#15221a',borderRadius:19,border:'1px solid #60725a',overflow:'hidden'}}><div style={{height:62,padding:'0 24px',display:'flex',alignItems:'center',gap:17,borderBottom:'1px solid #ffffff12',color:'#c9d6c5',fontSize:19}}><Terminal size={20}/>Agent · your-app</div><div style={{padding:33,fontSize:26,lineHeight:1.6,color:'#eff4e8'}}><div style={{display:'flex',gap:13}}><span style={{color:C.orange}}>❯</span><span>Test the checkout.</span></div><div style={{marginTop:31,color:'#9fb598',opacity:out(p(t,25.25,25.65))}}>Opening the browser…</div><div style={{marginTop:18,color:'#9fb598',opacity:out(p(t,26.4,26.7))}}>Checking the purchase flow…</div><div style={{marginTop:28,color:'#d6edcb',opacity:out(p(t,28.0,28.35)),display:'flex',gap:11}}><Check size={27} color="#a7d78e" style={{marginTop:8}}/>Checkout passed.</div><div style={{marginTop:35,fontSize:18,color:'#758d6e',opacity:out(p(t,28.25,28.6))}}>Browser • Terminal • Files</div></div></div>
   <div style={{position:'absolute',left:134,top:950,color:'#b2c2a7',fontSize:22}}>A desktop for your agents.</div>
  </div>
  {t>=19.85&&<BrowserPane rect={browserRect} success={t>=27.45} guest={toDesktop>.5} launch={toBrowser}/>}
  {t>=25.7&&<AgentCursor x={lerp(1140,1510,e(t,26.15,27.1))} y={lerp(855,740,e(t,26.15,27.1))} show={opacity(t,25.9,26.2,27.8,28.1)} press={Math.sin(Math.PI*p(t,27.2,27.48))} travel={p(t,26.15,27.1)}/>}
 </div>
}

function Outro({t}:{t:number}){
 const a=out(p(t,30.0,30.55)),brand=e(t,31.3,32.15);
 return <div style={{position:'absolute',inset:0,opacity:a}}>
  <div style={{opacity:1-e(t,30.95,31.3),transform:`translateY(${-100*brand}px)`}}><Office x={1510} y={561} scale={.7} run/><div className="display" style={{position:'absolute',left:130,top:95,fontSize:112}}>Less setup.</div><div className="display" style={{position:'absolute',right:133,top:848,fontSize:112}}>More building.</div></div>
  <div style={{position:'absolute',left:164,top:206,display:'flex',gap:34,alignItems:'center',opacity:brand,transform:`translateY(${45*(1-brand)}px)`}}><span style={{fontSize:144,fontWeight:650,letterSpacing:-8}}>Silo</span></div>
  <div className="display" style={{position:'absolute',left:157,top:463,fontSize:119,opacity:brand,transform:`translateY(${65*(1-brand)}px)`}}>Computers for<br/>your agents<span style={{color:'#d78100'}}>.</span></div>
  <div style={{position:'absolute',left:166,top:818,display:'flex',alignItems:'center',gap:24,opacity:out(p(t,32.3,32.8)),fontSize:29}}><span style={{padding:'18px 27px',borderRadius:10,background:C.ink,color:C.paper,display:'flex',gap:13,alignItems:'center'}}>Download Silo<ArrowUpRight size={27}/></span><span style={{color:'#636e61'}}>silo.polarzero.xyz</span></div>
  <div style={{position:'absolute',right:148,top:482,opacity:brand,transform:`rotate(${lerp(-18,0,brand)}deg)`}}><Mark size={350}/></div>
  <div style={{position:'absolute',left:169,top:970,...small,fontSize:16,color:C.muted,opacity:out(p(t,32.65,33.2))}}>macOS + Linux</div>
 </div>
}

function FilmScene(){const frame=useCurrentFrame(),{fps}=useVideoConfig(),t=frame/fps;return <AbsoluteFill className="film" style={{background:'transparent'}}>{t>=3.3&&t<WORKSPACE_HANDOFF&&<Remote t={t}/>} {t>=WORKSPACE_HANDOFF&&t<31.35&&<Workflow t={t}/>} {t<4.1&&<Intro t={t}/>} {t>=29.8&&<Outro t={t}/>}</AbsoluteFill>}

export function Film({blur=false}:{blur?:boolean}){const t=useCurrentFrame()/60; const moving=t<1.65||(t>3.1&&t<4.2)||(t>7.9&&t<11.2)||(t>14.5&&t<16.2)||(t>19.8&&t<21.2)||(t>23.1&&t<24.5)||(t>29.6&&t<32.2);return <AbsoluteFill className="film">{blur&&moving?<CameraMotionBlur samples={5} shutterAngle={180}><FilmScene/></CameraMotionBlur>:<FilmScene/>}</AbsoluteFill>;}

export function Study({variant=0}:{variant?:number}){
 const t=useCurrentFrame()/60;
 if(variant===0)return <AbsoluteFill className="film"><Remote t={4+t*.63}/></AbsoluteFill>;
 if(variant===1)return <AbsoluteFill className="film"><Workflow t={9+t*1.65}/></AbsoluteFill>;
 return <AbsoluteFill className="film"><Workflow t={15+t*1.1}/></AbsoluteFill>;
}

const Root=()=> <><Composition id="Silo" component={Film} defaultProps={{blur:false}} durationInFrames={2160} fps={60} width={1920} height={1080}/><Composition id="Study" component={Study} defaultProps={{variant:0}} durationInFrames={480} fps={60} width={1920} height={1080}/></>;
registerRoot(Root);

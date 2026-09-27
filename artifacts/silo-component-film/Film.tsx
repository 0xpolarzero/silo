import React from 'react';
import {AbsoluteFill, Composition, Img, staticFile, registerRoot, useCurrentFrame, useVideoConfig} from 'remotion';
import {CameraMotionBlur} from '@remotion/motion-blur';
import {Terminal, Code2, Play, Square, RotateCcw, Monitor, ArrowUpRight, Check, ChevronRight, Globe, Minus, Plus, LockKeyhole} from 'lucide-react';
import {SiloMark} from '@/components/silo-mark';
import {SandboxList, SandboxListItem, SandboxListRow, SandboxAction} from '@/features/sandboxes/components/sandbox-list';
import {ComputerBadge} from '@/features/sandboxes/components/computer-badge';
import {WorkspaceStatus} from '@/features/application/components/application-ui';
import {NetworkPage} from '@/features/application/pages/network-page';
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
const sceneTime=(seconds:number)=>seconds<2.2?seconds:seconds+.5;
const computer={id:'office',vmId:'your-app',name:'Office computer',address:'office.local',connected:true};
const base=applicationSourceForScenario('running').workspaces[0];
const workspace={...base,machine:{...base.machine,id:'your-app',name:'your-app'},state:'running' as const,freshness:'fresh' as const,computer};

function Mark({size=48,color=C.ink}:{size?:number;color?:string}){return <SiloMark style={{width:size,height:size,color}}/>}
function Label({children,x,y,color=C.muted}:{children:React.ReactNode;x:number;y:number;color?:string}){return <div style={{position:'absolute',left:x,top:y,...small,color}}>{children}</div>}
function Dots(){return <div style={{display:'flex',gap:7}}>{['#e0a69c','#dfc17b','#a9c2a2'].map(c=><i key={c} style={{display:'block',width:10,height:10,borderRadius:10,background:c}}/>)}</div>}
function Cursor({x,y,show=1,press=0}:{x:number;y:number;show?:number;press?:number}){
 return <div style={{position:'absolute',left:x-4,top:y-3,opacity:show,transform:`scale(${1-press*.08})`,transformOrigin:'4px 3px',filter:'drop-shadow(0 2px 2px #0003)',zIndex:30,pointerEvents:'none'}}><svg width="40" height="47" viewBox="0 0 40 47"><path d="M4 3v32l9-8 8 16 7-4-8-15 12-2Z" fill="white" stroke={C.ink} strokeWidth="2.5" strokeLinejoin="round"/></svg></div>
}
function AgentCursor({x,y,show=1,press=0,travel=0}:{x:number;y:number;show?:number;press?:number;travel?:number}){
 const scale=1.8,tilt=27*Math.sin(travel*Math.PI),stretch=1-.12*Math.sin(travel*Math.PI);
 return <div style={{position:'absolute',left:x-12*scale,top:y-12*scale,width:24,height:24,transform:`scale(${scale})`,transformOrigin:'0 0',zIndex:30,pointerEvents:'none'}}>
  <div style={{width:24,height:24,opacity:show,transformOrigin:'12px 12px',transform:`rotate(${-44+tilt}deg) scale(${stretch*lerp(.4,1,show)*(1-press*.08)},${lerp(.4,1,show)*(1-press*.08)})`,filter:`blur(${5*(1-show)}px)`}}>
   <div style={{transform:'translate3d(12px,-2.5px,0)'}}><Img src={staticFile('codex-agent-cursor.png')} width={23} height={24} style={{display:'block',transform:'rotate(44deg)',transformOrigin:'0 0',filter:'drop-shadow(0 0 6px #339cffe6) drop-shadow(0 0 15px #339cff7a)'}}/></div>
  </div>
 </div>
}
function NativeRow({running=true,name='your-app',t=0,secondary=false}:{running?:boolean;name?:string;t?:number;secondary?:boolean}){
 const pressed=(a:number,b:number)=>Math.sin(Math.PI*p(t,a,b));
 const buttonStyle=(press:number):React.CSSProperties=>({background:`rgba(255,159,10,${press*.22})`,transform:`scale(${1-press*.12})`});
 return <div className="native-ui" style={{width:760,opacity:secondary?.45:1}}><SandboxList label="Sandboxes"><SandboxListItem><SandboxListRow name={name} kind="vm" remote kindBadge={<ComputerBadge computer={computer}/>} tone={running?'running':'stopped'} detail={<span style={{display:'flex',gap:12,alignItems:'center'}}><WorkspaceStatus state={running?'running':'stopped'}/><span>{machineSummary(workspace.machine)}</span></span>} actions={<><SandboxAction label={`Open ${name} in Terminal`} style={buttonStyle(secondary?0:pressed(9.5,9.75))}><Terminal/></SandboxAction><SandboxAction label={`Open ${name} in editor`} style={buttonStyle(secondary?0:pressed(10.45,10.7))}><Code2/></SandboxAction><SandboxAction label="Open Linux desktop"><Monitor/></SandboxAction><SandboxAction label={running?`Stop ${name}`:`Start ${name}`} style={buttonStyle(secondary?0:pressed(6.04,6.28))}>{running?<Square/>:<Play/>}</SandboxAction><SandboxAction label={`Restart ${name}`}><RotateCcw/></SandboxAction></>}/></SandboxListItem></SandboxList></div>
}

function NativeNetwork({connected=false}:{connected?:boolean}){
 const actions={openNetworkPort:async()=>{},saveNetworkPort:async()=>{},removeNetworkPort:async()=>{}} as any;
 const network={workspaces:[{workspace:workspaceTarget(workspace),error:null,ports:[{port:3000,hostPort:connected?51432:null,scheme:'http' as const,state:connected?'reachable' as const:'unpublished' as const,configured:connected}]}]};
 return <div className="native-ui film-network" style={{width:760}}><NetworkPage workspaces={[workspace]} browser="Browser" network={network} actions={actions} active={false}/></div>
}

function ProductWindow({rect,t}:{rect:Rect;t:number}){
 const scale=rect.w/840;
 return <div style={{...pos(rect),borderRadius:22,overflow:'hidden',background:'white',boxShadow:'0 26px 80px #1722181b',border:'1px solid #d2d5cd'}}>
  <div style={{position:'absolute',left:0,top:0,width:840,height:rect.h/scale,transform:`scale(${scale})`,transformOrigin:'0 0'}}>
   <div style={{height:43,display:'flex',alignItems:'center',padding:'0 18px',gap:18,borderBottom:'1px solid #e9eae5',background:'#fafbf8'}}><Dots/><div style={{display:'flex',alignItems:'center',gap:7,fontSize:12,fontWeight:650}}><Mark size={21}/>Silo</div><span style={{marginLeft:'auto',fontSize:11,color:C.muted}}>Office computer</span></div>
   <div style={{padding:'21px 40px'}}>
    <div style={{height:20,display:'flex',alignItems:'center',marginBottom:16,fontSize:18,fontWeight:600,letterSpacing:-.4}}>Sandboxes</div>
    <NativeRow running={t>=6.55} t={t}/>
    <div style={{display:'grid',gap:10,marginTop:10,opacity:1-e(t,7.9,8.55)}}><NativeRow name="api" running={false} secondary/><NativeRow name="playground" running={false} secondary/></div>
   </div>
  </div>
 </div>
}

function Office({x=1420,y=552,scale=1,run=false,arrival=0}:{x?:number;y?:number;scale?:number;run?:boolean;arrival?:number}){
 const energy=Math.sin(Math.PI*clamp(arrival)),ring=out(arrival);
 return <div style={{position:'absolute',left:x,top:y,transform:`scale(${scale})`,transformOrigin:'50% 50%'}}>
  <svg width="290" height="280" viewBox="0 0 290 280" style={{overflow:'visible'}}><defs><linearGradient id="metal" x2="0" y2="1"><stop stopColor="#e6e8df"/><stop offset="1" stopColor="#bbc2b8"/></linearGradient><radialGradient id="power"><stop stopColor="#ffb83f" stopOpacity=".8"/><stop offset="1" stopColor="#ff9f0a" stopOpacity="0"/></radialGradient></defs>
   <ellipse cx="143" cy="239" rx="153" ry="43" fill="url(#power)" opacity={energy*.9}/>
   <g transform={`translate(0 ${-5*energy})`}><ellipse cx="143" cy="218" rx="126" ry="20" fill="#172218" opacity=".09"/><path d="M19 79 127 18q14-8 29 0l112 63v92q0 10-10 15l-106 56q-10 4-22-2L27 186q-8-5-8-15Z" fill="url(#metal)"/>
   <path d="m20 80 120 66 128-65M140 146v98" fill="none" stroke="#a9b2a6" strokeWidth="2"/>
   <path d="m72 65 58-33q9-5 18 0l65 36-66 36q-6 3-11 0Z" fill="#dde2d7" stroke="#a9b2a6"/>
   <path d="M19 79 127 18q14-8 29 0l112 63-128 65Z" fill={C.orange} opacity={energy*.17}/>
   <path d="M19 79 127 18q14-8 29 0l112 63-128 65Z" fill="none" stroke={C.orange} strokeWidth="2.5" opacity={energy*.85}/>
   <circle cx="239" cy="166" r={run?6:4} fill={run?C.green:'#778276'}/><circle cx="239" cy="166" r={10+13*energy} fill={C.green} opacity={energy*.22}/>
   <path d="M44 147v14m12-8v14" stroke={energy>.05?'#df940e':'#84917d'} strokeWidth="4" strokeLinecap="round"/></g>
   {arrival>0&&arrival<1&&<ellipse cx="144" cy={79-18*ring} rx={105+64*ring} ry={54+32*ring} fill="none" stroke={C.orange} strokeWidth={2*(1-ring)} opacity={(1-ring)*.55}/>}
  </svg>
 </div>
}

const WIRE='M1057 638H1260q50 0 50 50v0q0 22 22 22h132';
function Wire({progress=1,pulse=0}:{progress?:number;pulse?:number}){return <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}><path d={WIRE} fill="none" stroke="#bfc7bb" strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1-progress}/>{pulse>0&&pulse<1&&<path d={WIRE} fill="none" stroke={C.orange} strokeWidth="13" strokeLinecap="round" pathLength="1" strokeDasharray=".012 .988" strokeDashoffset={1-pulse}/>}</svg>}

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

const SHOP={quantity:23.8,checkout:24.75,focus:25.35,typeStart:25.45,typeEnd:26.45,submit:27.15,success:27.45};
function WebApp({t=0,unit=1}:{t?:number;unit?:number}){
 const quantity=t>=SHOP.quantity?2:1;
 const productExit=e(t,SHOP.checkout,SHOP.checkout+.14),checkoutEnter=e(t,SHOP.checkout+.14,SHOP.checkout+.34),checkoutExit=e(t,SHOP.success,SHOP.success+.14),receiptEnter=e(t,SHOP.success+.14,SHOP.success+.36);
 const email='alex@example.com'.slice(0,Math.floor(p(t,SHOP.typeStart,SHOP.typeEnd)*16));
 return <div style={{width:'100%',height:'100%',background:'#f9f7f0',position:'relative',padding:'3.7% 5%'}}>
  <div style={{fontSize:28*unit,fontWeight:650,letterSpacing:-1}}>form<span style={{color:'#bb6039'}}>.</span><span style={{float:'right',fontSize:17*unit,fontWeight:400,letterSpacing:0,color:'#798275'}}>Objects for everyday.</span></div>
  <div style={{display:'flex',alignItems:'center',height:'84%',gap:'6%'}}>
   <div style={{width:'48%',height:'85%',background:'#eadfcf',borderRadius:9,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}><Lamp scale={.9*unit}/></div>
   <div style={{flex:1,height:'100%',position:'relative',display:'flex',alignItems:'center',overflow:'hidden'}}>
    <div style={{width:'100%',opacity:1-productExit,transform:`translateY(${-8*productExit}px)`}}>
     <div style={{...small,fontSize:14*unit,color:'#a17355'}}>Made for slow evenings</div><div style={{fontFamily:'Georgia,serif',fontSize:57*unit,lineHeight:1.13,letterSpacing:-2,marginTop:17}}>Studio<br/>lamp.</div><p style={{fontSize:20*unit,color:'#74806f',marginTop:19,lineHeight:1.6}}>Warm light.<br/>A little room to think.</p>
     <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:16,height:36*unit}}><div style={{fontSize:29*unit}}>€{89*quantity}</div><div style={{display:'flex',alignItems:'center',border:'1px solid #ced1c5',borderRadius:6,height:36*unit,fontSize:20*unit,overflow:'hidden'}}><span style={{width:33*unit,display:'grid',placeItems:'center'}}><Minus size={15*unit}/></span><span style={{width:23*unit,textAlign:'center'}}>{quantity}</span><span style={{width:33*unit,height:'100%',display:'grid',placeItems:'center',background:t>=SHOP.quantity?'#e1e6d9':undefined}}><Plus size={15*unit}/></span></div></div>
     <div style={{display:'flex',alignItems:'center',justifyContent:'center',marginTop:22,padding:`${18*unit}px ${16*unit}px`,background:'#252e26',color:'#fff',borderRadius:6,fontSize:20*unit}}>Buy now</div>
    </div>
    <div style={{position:'absolute',inset:0,opacity:checkoutEnter*(1-checkoutExit),transform:`translateY(${8*(1-checkoutEnter)-8*checkoutExit}px)`}}>
     <div style={{position:'absolute',top:66,fontSize:35,fontFamily:'Georgia,serif',letterSpacing:-1}}>Checkout</div>
     <div style={{position:'absolute',top:122,left:0,right:0,display:'flex',justifyContent:'space-between',fontSize:18,color:'#74806f'}}><span>2 × Studio lamp</span><span style={{color:'#252e26'}}>€178</span></div>
     <div style={{position:'absolute',top:180,fontSize:15,color:'#74806f'}}>Email</div>
     <div style={{position:'absolute',top:207,left:0,right:0,height:46,display:'flex',alignItems:'center',padding:'0 12px',background:'#fffdf8',border:`${t>=SHOP.focus?2:1}px solid ${t>=SHOP.focus?'#7e9879':'#cbd1c4'}`,borderRadius:6,fontSize:18,color:email?'#252e26':'#a4ad9f'}}>{email||'you@example.com'}{t>=SHOP.focus&&t<SHOP.submit&&<span style={{height:20,width:1,background:'#526b4d',marginLeft:2}}/>}</div>
     <div style={{position:'absolute',top:278,left:0,right:0,height:48,display:'flex',alignItems:'center',justifyContent:'center',gap:10,background:'#252e26',color:'white',borderRadius:6,fontSize:17}}><LockKeyhole size={16}/>Place order</div>
    </div>
    <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'flex-start',opacity:receiptEnter,transform:`translateY(${8*(1-receiptEnter)}px)`}}><div style={{width:56,height:56,borderRadius:50,background:'#deead9',color:'#35604a',display:'grid',placeItems:'center',marginBottom:24}}><Check size={30}/></div><div style={{fontFamily:'Georgia,serif',fontSize:37,lineHeight:1.12,letterSpacing:-1}}>Order<br/>confirmed.</div><div style={{fontSize:18,marginTop:24,color:'#74806f'}}>2 × Studio lamp · €178</div></div>
   </div>
  </div>
 </div>
}

function agentPose(t:number){
 const positions=[{start:23.0,end:23.55,from:{x:1140,y:835},to:{x:1627,y:685}}, {start:24.0,end:24.55,from:{x:1627,y:685},to:{x:1510,y:744}}, {start:24.95,end:25.3,from:{x:1510,y:744},to:{x:1450,y:620}}, {start:26.55,end:27.0,from:{x:1450,y:620},to:{x:1468,y:692}}, {start:27.45,end:27.8,from:{x:1468,y:692},to:{x:1635,y:845}}];
 const move=[...positions].reverse().find(v=>t>=v.start)||positions[0],q=e(t,move.start,move.end);
 const press=Math.max(...[SHOP.quantity,SHOP.checkout,SHOP.focus,SHOP.submit].map(at=>Math.sin(Math.PI*p(t,at-.09,at+.09))));
 return {x:lerp(move.from.x,move.to.x,q),y:lerp(move.from.y,move.to.y,q),travel:p(t,move.start,move.end),press};
}

function BrowserPane({rect,t=0,guest=false,launch=1}:{rect:Rect;t?:number;guest?:boolean;launch?:number}){
 const header=lerp(82,62,launch),fontSize=lerp(23.88,lerp(16,21,clamp((rect.w-832)/620)),launch);
 return <div style={{...pos(rect),border:'1px solid #d7dbd1',borderRadius:lerp(12,20,launch),overflow:'hidden',background:'#fff',boxShadow:`0 ${25*launch}px ${75*launch}px #1722181a`}}>
  <div style={{height:header,position:'relative',display:'flex',alignItems:'center',padding:'0 24px',gap:26,background:'#fcfdf9',borderBottom:'1px solid #e4e8de'}}>
   <div style={{opacity:launch}}><Dots/></div><div style={{height:35,borderRadius:8,background:'#eff2e9',flex:1,opacity:launch}}/><ArrowUpRight size={20} color={C.muted} style={{opacity:launch}}/>
   <div className="mono" style={{position:'absolute',left:lerp(241,rect.w/2+12,launch),top:(header-32)/2,transform:`translateX(${-50*launch}%)`,display:'flex',alignItems:'center',height:32,fontSize,color:`color-mix(in srgb,#747474 ${100*(1-launch)}%,#52614e)`,whiteSpace:'nowrap'}}><span style={{display:'flex',width:27*launch,overflow:'hidden',opacity:launch}}><Globe size={16}/></span><span style={{width:fontSize*.602*7*(1-e(launch,.15,.65)),overflow:'hidden',opacity:1-e(launch,0,.12)}}>http://</span>{guest?'localhost:3000':'127.0.0.1:51432'}</div>
  </div>
  <div style={{height:Math.max(0,rect.h-header),overflow:'hidden'}}><div style={{height:Math.max(560,rect.h-header)}}><WebApp t={t} unit={lerp(.74,1,clamp((rect.w-832)/620))}/></div></div>
 </div>
}

function Intro({t}:{t:number}){
 const exit=e(t,3.1,4.05), rows=[['COMPUTERS',0],['FOR YOUR',.54],['AGENTS.',.96]] as const;
 return <div style={{position:'absolute',inset:0,transform:`translateY(${-1100*exit}px)`,opacity:1-e(t,3.7,4.05)}}>
  <div style={{position:'absolute',left:139,top:106,display:'flex',alignItems:'center',gap:14,opacity:.4+.6*out(p(t,0,.3))}}><Mark size={38}/><span style={{fontSize:25,fontWeight:650}}>Silo</span></div>
  {rows.map(([word,a],i)=><div key={word} style={{position:'absolute',left:128,top:190+i*212,width:1664,height:262,paddingTop:24,overflow:i===0?'visible':'hidden'}}><div className="display" style={{fontSize:234,color:i===2?C.orange:C.ink,transform:i===0?`scale(${1+.18*(1-out(p(t,a,a+.56)))})`:`translateY(${(1-out(p(t,a,a+.56)))*264}px)`,transformOrigin:'0 50%'}}>{word}</div></div>)}
  <div style={{position:'absolute',right:139,top:437,width:246,height:246,transform:`rotate(${lerp(-80,0,out(p(t,1,2.15)))}deg) scale(${out(p(t,1,1.9))})`}}><Mark size={246}/></div>

 </div>
}

function Remote({t}:{t:number}){
 const push=e(t,7.9,WORKSPACE_HANDOFF);const r=mixRect({x:132,y:420,w:925,h:450},APP_RECT,push);
 const show=out(p(t,3.45,4.15));const run=t>=6.55;
 return <div style={{position:'absolute',inset:0,opacity:show}}>
  <div style={{opacity:1-push}}><div className="display" style={{position:'absolute',left:132,top:172,fontSize:108,transform:`translateY(${35*(1-show)}px)`}}>Start it here.</div><div className="display" style={{position:'absolute',left:1245,top:342,fontSize:94}}>Run it<br/><span style={{color:'#cd7800'}}>there.</span></div><Label x={136} y={934}>Your laptop</Label><Label x={1384} y={868}>Office computer</Label><Wire progress={out(p(t,4.65,5.5))} pulse={p(t,6.08,6.55)}/><Office run={run} arrival={p(t,6.55,7.35)}/></div>
  <ProductWindow rect={r} t={t}/>
  <div style={{position:'absolute',left:r.x-30*(1-push),top:r.y+r.h-1,width:r.w+60*(1-push),height:24*(1-push),background:'#b9c1b4',borderRadius:'0 0 35px 35px',opacity:1-push}}/>
  <div style={{position:'absolute',left:r.x+r.w*.39,top:r.y+r.h,width:r.w*.22,height:8,background:'#8e9b86',borderRadius:'0 0 10px 10px',opacity:1-push}}/>
  {t<7.5&&<Cursor x={lerp(921,962,e(t,5.3,6.0))} y={lerp(692,561,e(t,5.3,6.0))} show={opacity(t,5.1,5.4,6.9,7.3)} press={Math.sin(Math.PI*p(t,6.04,6.28))}/>}
 </div>
}

function Workflow({t}:{t:number}){
 const enter=e(t,9.55,10.3);const edit=e(t,10.5,11.1);const toBrowser=e(t,17.85,19.15);const toDesktop=e(t,21.1,22.45);const finish=e(t,29.6,31.0);
 const bgRect=APP_RECT;
 const terminalRect=mixRect({x:1433,y:350,w:50,h:50},{x:202,y:467,w:854,h:435},enter);
 const codeRect=mixRect({x:1485,y:350,w:50,h:50},{x:1082,y:467,w:632,h:435},edit);
 const browserStart={x:202,y:596,w:1512,h:82};
 const browserHero=APP_RECT;
 const guestRect={x:850,y:265,w:832,h:650};
 const browserRect=mixRect(mixRect(browserStart,browserHero,toBrowser),guestRect,toDesktop);
 const uiFade=1-toBrowser; const retreat=e(t,29.6,30.5);
 return <div style={{position:'absolute',left:0,top:0,width:1920,height:1080,transform:`translate(${475*retreat}px,${235*retreat}px) scale(${lerp(1,.505,retreat)})`,transformOrigin:'0 0',borderRadius:28*retreat,overflow:'hidden',boxShadow:retreat>0?'0 24px 70px #17221824':undefined,opacity:1-e(t,30.95,31.3)}}>
  <div><ProductWindow rect={bgRect} t={t}/></div>
  
  <div style={{position:'absolute',inset:0,clipPath:'inset(315px 200px 150px 200px)',visibility:t>15.4?'hidden':'visible'}}><div style={{opacity:out(p(t,9.55,9.8)),transform:`translateX(${-1050*e(t,14.55,15.4)}px)`}}><TerminalPane rect={terminalRect} t={t}/></div><div style={{opacity:out(p(t,10.5,10.75)),transform:`translateX(${790*e(t,14.65,15.4)}px)`}}><EditorPane rect={codeRect}/></div></div>
  <div style={{position:'absolute',inset:0,clipPath:'inset(445px 200px 140px 200px)',visibility:t<15.05?'hidden':'visible'}}><div style={{opacity:uiFade,position:'absolute',inset:0,transform:`translateY(${460*(1-e(t,15.05,15.95))}px)`}}>
   
   <div style={{position:'absolute',left:202,top:450,transform:'scale(1.99)',transformOrigin:'0 0'}}><NativeNetwork connected={t>=17.35}/></div>
  </div>
  </div>
  {t>=12.1&&t<19.15&&(()=>{const first=e(t,14.55,15.17),last=e(t,15.17,16.1);const x=lerp(lerp(547,723,first),228,last),y=lerp(lerp(759,508,first),621,last),size=lerp(lerp(24,185,first),23.88,last);return <div className="mono" style={{position:'absolute',left:x,top:y,fontSize:size,lineHeight:lerp(1.65,4/3,last),fontWeight:lerp(400,500,last),color:`rgb(${Math.round(lerp(255,23,last))},${Math.round(lerp(159,27,last))},${Math.round(lerp(10,24,last))})`,opacity:out(p(t,12.1,12.35))*uiFade,pointerEvents:'none'}}>3000</div>})()}
  {t<15&&<Cursor x={t<10?lerp(1530,1458,e(t,9.2,9.48)):lerp(1458,1510,e(t,10.1,10.4))} y={t<10?lerp(520,373,e(t,9.2,9.48)):373} show={opacity(t,9.2,9.42,10.8,11.05)} press={t<10?Math.sin(Math.PI*p(t,9.5,9.75)):Math.sin(Math.PI*p(t,10.45,10.7))}/>}
  {t>=15.9&&t<18.2&&<Cursor x={t<17.4?lerp(1720,1662,e(t,15.95,16.65)):lerp(1662,1497,e(t,17.4,17.65))} y={t<17.4?lerp(816,636,e(t,15.95,16.65)):636} show={opacity(t,15.9,16.1,17.9,18.15)} press={t<17.4?Math.sin(Math.PI*p(t,17.1,17.4)):Math.sin(Math.PI*p(t,17.6,17.85))}/>}

  <div style={{position:'absolute',inset:0,clipPath:`inset(0 ${(1-toDesktop)*100}% 0 0)`}}>
   <div style={{position:'absolute',inset:0,background:'#24342b'}}/>
   <div style={{position:'absolute',left:133,top:102,color:'#f1f4ea',display:'flex',gap:14,alignItems:'center'}}><Mark size={43} color="#f1f4ea"/><div style={{fontSize:30}}>your-app <span style={{color:'#9fae9d'}}> / Linux desktop</span></div></div>
   <div style={{position:'absolute',right:132,top:112,color:'#b5c3b4',fontSize:19,display:'flex',alignItems:'center',gap:11}}><span style={{width:8,height:8,borderRadius:10,background:C.orange}}/>Office computer</div>
   <div style={{position:'absolute',left:134,top:270,width:647,height:640,background:'#15221a',borderRadius:19,border:'1px solid #60725a',overflow:'hidden'}}>
    <div style={{height:62,padding:'0 24px',display:'flex',alignItems:'center',gap:17,borderBottom:'1px solid #ffffff12',color:'#c9d6c5',fontSize:19}}><Terminal size={20}/>Agent · your-app</div>
    <div style={{padding:33,fontSize:26,lineHeight:1.6,color:'#eff4e8'}}>
     <div style={{display:'flex',gap:13}}><span style={{color:C.orange}}>❯</span><span>Test a two-item checkout.</span></div>
     <div style={{marginTop:40,display:'grid',gap:20}}>{[['Quantity and total update',24.0],['Customer details accepted',26.65],['Order confirmed',27.8]].map(([label,at])=><div key={label} style={{display:'flex',gap:12,alignItems:'center',fontSize:23,color:'#bfd0b7',opacity:out(p(t,Number(at),Number(at)+.25)),transform:`translateY(${8*(1-out(p(t,Number(at),Number(at)+.25)))}px)`}}><Check size={23} color="#a7d78e"/>{label}</div>)}</div>
     <div style={{marginTop:36,fontSize:31,fontWeight:550,color:'#e1efd8',opacity:out(p(t,28.15,28.45))}}>3 checks passed.</div>
    </div>
   </div>
  </div>
  {t>=17.85&&<BrowserPane rect={browserRect} t={t} guest={toDesktop>.5} launch={toBrowser}/>}
  {t>=22.75&&<AgentCursor {...agentPose(t)} show={opacity(t,22.75,23.0,27.9,28.15)}/>}
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

function FilmScene(){const frame=useCurrentFrame(),{fps}=useVideoConfig(),t=sceneTime(frame/fps);return <AbsoluteFill className="film" style={{background:'transparent'}}>{t>=3.3&&t<WORKSPACE_HANDOFF&&<Remote t={t}/>} {t>=WORKSPACE_HANDOFF&&t<31.35&&<Workflow t={t}/>} {t<4.1&&<Intro t={t}/>} {t>=29.8&&<Outro t={t}/>}</AbsoluteFill>}

export function Film({blur=false}:{blur?:boolean}){const t=sceneTime(useCurrentFrame()/60); const moving=t<1.65||(t>3.1&&t<4.2)||(t>7.9&&t<11.2)||(t>14.5&&t<16.2)||(t>17.8&&t<19.2)||(t>21.1&&t<22.5)||(t>29.6&&t<32.2);return <AbsoluteFill className="film">{blur&&moving?<CameraMotionBlur samples={5} shutterAngle={180}><FilmScene/></CameraMotionBlur>:<FilmScene/>}</AbsoluteFill>;}

export function Study({variant=0}:{variant?:number}){
 const t=useCurrentFrame()/60;
 if(variant===0)return <AbsoluteFill className="film"><Remote t={4+t*.63}/></AbsoluteFill>;
 if(variant===1)return <AbsoluteFill className="film"><Workflow t={9+t*1.65}/></AbsoluteFill>;
 return <AbsoluteFill className="film"><Workflow t={15+t*1.1}/></AbsoluteFill>;
}

const Root=()=> <><Composition id="Silo" component={Film} defaultProps={{blur:false}} durationInFrames={2160} fps={60} width={1920} height={1080}/><Composition id="Study" component={Study} defaultProps={{variant:0}} durationInFrames={480} fps={60} width={1920} height={1080}/></>;
registerRoot(Root);

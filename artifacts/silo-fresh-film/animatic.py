"""Fresh Silo animatic. Pure, frame-seekable Pillow compositor, no browser capture.
Run with bundled Python: python3 animatic.py [--stills]
All work is illustrative fixture data. No VMs or external services are invoked.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
from pathlib import Path
import math, subprocess, sys, json
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'render'; OUT.mkdir(exist_ok=True)
W,H=1920,1080; FPS=60; DURATION=11
INK='#17191c'; PAPER='#f1f0ec'; ORANGE='#ff9f0a'; MUTED='#888b91'; LINE='#d8d8d4'; GREEN='#38a975'
FONT='/System/Library/Fonts/HelveticaNeue.ttc'; MONO='/System/Library/Fonts/Menlo.ttc'
fonts={}
def ft(n,bold=False,mono=False):
 key=(round(n),bold,mono)
 if key not in fonts: fonts[key]=ImageFont.truetype(MONO if mono else FONT,round(n),index=0 if mono else int(bold))
 return fonts[key]
def text(im,pos,s,size=32,fill=INK,bold=False,mono=False,anchor=None):
 ImageDraw.Draw(im).text(pos,s,font=ft(size,bold,mono),fill=fill,anchor=anchor,stroke_width=0)
def rr(im,box,r,fill,outline=None,width=1):ImageDraw.Draw(im).rounded_rectangle(box,r,fill=fill,outline=outline,width=width)
def line(im,p,fill,width=2):ImageDraw.Draw(im).line(p,fill=fill,width=width,joint='curve')
def circle(im,box,fill,outline=None,width=1):ImageDraw.Draw(im).ellipse(box,fill,outline,width)
def ease(t):t=max(0,min(1,t));return t*t*t*(t*(t*6-15)+10)
def p(t,a,b):return ease((t-a)/(b-a))
def mix(a,b,t):return a+(b-a)*t
def lerpq(a,b,t):return [(mix(x,u,t),mix(y,v,t)) for (x,y),(u,v) in zip(a,b)]
def col(a,b,t):
 a=tuple(int(a[i:i+2],16) for i in (1,3,5));b=tuple(int(b[i:i+2],16) for i in (1,3,5))
 return tuple(round(mix(x,y,t)) for x,y in zip(a,b))
def warp(base,src,q,alpha=1):
 if alpha<=0:return
 src=src.convert('RGBA')
 if alpha<1:src.putalpha(src.getchannel('A').point(lambda a:round(a*alpha)))
 sw,sh=src.size;orig=[(0,0),(sw,0),(sw,sh),(0,sh)]
 A=[];B=[]
 for (x,y),(u,v) in zip(q,orig):
  A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);B.extend([u,v])
 coeff=np.linalg.solve(np.array(A),np.array(B))
 layer=src.transform((W,H),Image.Transform.PERSPECTIVE,coeff,Image.Resampling.BICUBIC)
 base.alpha_composite(layer)
def mark(im,x,y,size,color=INK):
 d=ImageDraw.Draw(im)
 # Original mark's three interrupted levels. Arc rotation approximates supplied SVG.
 for r,start,end,c in [(0.46,28,276,color),(.305,110,372,color),(.153,155,425,ORANGE)]:
  d.arc((x+size*(.5-r),y+size*(.5-r),x+size*(.5+r),y+size*(.5+r)),start,end,fill=c,width=max(2,round(size*.082)))
def server(im,x,y,s=1,c=INK):
 for yy in [y,y+22*s]:
  rr(im,(x,yy,x+38*s,yy+15*s),3*s,None,c,max(1,round(2*s)));circle(im,(x+6*s,yy+5*s,x+10*s,yy+9*s),c)
def browser(t,local=False,wide=False,width=1400,height=850):
 im=Image.new('RGBA',(width,height),'#ffffff');d=ImageDraw.Draw(im)
 # Responsive scene. Letterforms and orbital geometry are never stretched.
 u=width/1400;v=height/850
 dark=p(t,4.35,5.08)
 # Theme crosses as a sharp wipe, making the edit more decisive than a grey crossfade.
 isdark=t>=4.63
 bg='#181b23' if isdark else '#f4f0e5';fg='#f6f1e7' if isdark else '#191e28'
 im.paste(bg,(0,65,width,height))
 rr(im,(0,0,width,65),0,'#f9f9f8');line(im,[(0,64),(width,64)],'#d9d9d5',2)
 for x,c in [(22,'#f48178'),(42,'#e5c066'),(62,'#73bc89')]:circle(im,(x,27,x+10,37),c)
 d.arc((104,19,130,45),35,312,fill='#72767c',width=3);d.polygon([(126,16),(134,23),(124,26)],fill='#72767c')
 rr(im,(170,14,width-150,50),8,'#eaeae7');text(im,((170+width-150)/2,32),'127.0.0.1:3000' if local else 'localhost:3000',22,'#575b63',mono=True,anchor='mm')
 text(im,(54,108),'AFTER HOURS',25,fg,True)
 if width>1000:text(im,(width-74,108),'Studio  /  01',21,fg,anchor='ra')
 # Art is drawn before type and confined to its own disc.
 compact=(1-u)/(1-830/1400)
 cx=mix(1040,width*.69,compact);cy=mix(447,440,compact);radius=mix(227,165,compact)
 orb=Image.new('RGBA',(round(radius*2),round(radius*2)),ORANGE)
 od=ImageDraw.Draw(orb);shift=mix(-2*radius,-58,dark)
 od.ellipse((shift,-13,2*radius+shift,2*radius-13),fill=bg)
 mask=Image.new('L',orb.size);ImageDraw.Draw(mask).ellipse((0,0,orb.width-1,orb.height-1),fill=255);orb.putalpha(mask)
 im.alpha_composite(orb,(round(cx-radius),round(cy-radius)))
 for off in [0,25,50]:d.arc((cx-radius-off,cy-radius-off,cx+radius+off,cy+radius+off),-35,55,fill='#525867' if isdark else '#cbbd9d',width=2)
 fs=mix(114,73,compact)
 text(im,(54,270),'Stay',fs,fg,True);text(im,(52,270+fs*.97),'curious.',fs,fg,True)
 if width>1000:text(im,(56,544),'A little space for your next idea.',28,'#aaaeb6' if isdark else '#67675f')
 rr(im,(54,625,335,705),40,fg);text(im,(194,663),'Explore the studio',25,bg,True,anchor='mm')
 text(im,(cx,height-43),'NIGHT STUDIES' if isdark else 'DAY STUDIES',18,'#9295a0' if isdark else '#767366',mono=True,anchor='mm')
 return im

CURSOR=Image.open(ROOT/'assets/codex-agent-cursor.png').convert('RGBA')
def cursor(im,x,y,scale=1):
 c=CURSOR.resize((round(46*scale),round(48*scale)),Image.Resampling.LANCZOS);im.alpha_composite(c,(round(x),round(y)))
def guest(t):
 im=Image.new('RGBA',(1400,850),'#23262d')
 rr(im,(0,0,1400,72),0,'#f7f7f5');server(im,27,20,.65,'#555b61')
 text(im,(76,21),'studio',29,INK,True);rr(im,(190,19,341,53),17,'#e6e6e2');text(im,(264,36),'Office Mac',21,'#64666b',anchor='mm')
 circle(im,(367,29,380,42),GREEN);text(im,(391,23),'Running',22,'#626770')
 text(im,(1365,33),'Linux desktop',24,'#65686e',anchor='rm')
 grow=p(t,4.4,5.45);left=mix(570,0,grow)
 # Editor remains under the preview as its consequence takes over the composition.
 rr(im,(0,72,570,850),0,'#24272f')
 text(im,(34,108),'index.html',25,'#d4d6da',mono=True)
 text(im,(34,202),'01',24,'#646b78',mono=True)
 text(im,(87,202),'<html',34,'#bfc5cf',mono=True)
 text(im,(34,266),'02',24,'#646b78',mono=True)
 text(im,(88,266),'data-theme=',34,'#a3bed3',mono=True)
 selection=p(t,2.5,2.7)*(1-p(t,3.2,3.4))
 if selection:rr(im,(87,317,315,372),5,('#375983'))
 val='light' if t<3.13 else 'dark'
 text(im,(88,322),'"'+val+'"',42,ORANGE,mono=True)
 text(im,(34,391),'03',24,'#646b78',mono=True);text(im,(87,391),'>',34,'#bec4cc',mono=True)
 text(im,(35,755),'Saved' if t>3.63 else 'Editing',24,'#8bc9aa' if t>3.63 else '#8d94a2',mono=True)
 if 2.02<t<3.8:
  text(im,(36,527),'Give it a',42,'#e4e7ed',True);text(im,(36,577),'dark theme.',42,'#e4e7ed',True)
 b=browser(t,width=round(1400-left),height=778);im.alpha_composite(b,(round(left),72))
 # Explicit sequence: select value, edit, save; then refresh browser.
 if 2.0<t<4.6:
  x=mix(444,268,p(t,2.0,2.52));y=mix(493,342,p(t,2.0,2.52))
  if t>3.73:x=mix(268,647,p(t,3.73,4.22));y=mix(342,105,p(t,3.73,4.22))
  cursor(im,x,y,.82)
 return im

def silo():
 im=Image.new('RGBA',(1400,850),'#fafaf9');mark(im,47,45,56);text(im,(122,48),'Silo',49,INK,True)
 text(im,(55,184),'Virtual machines',50,INK,True)
 rr(im,(52,287,1348,490),16,'#fff',LINE,2)
 rr(im,(83,329,166,412),14,'#eeeeeb');server(im,106,350,1.1,'#656970')
 text(im,(202,316),'studio',47,INK,True);rr(im,(370,325,580,374),24,'#efefec');text(im,(475,349),'Office Mac',28,'#6a6e76',anchor='mm')
 circle(im,(207,407,221,421),GREEN);text(im,(237,396),'Running',29,'#727780')
 rr(im,(80,563,1318,753),13,'#21252b');text(im,(118,594),'silo@studio  ~',30,'#9299a4',mono=True)
 text(im,(118,659),'> Give it a dark theme.',43,'#f1f1eb',mono=True)
 return im
SILO=silo()

def laptop(im,q,screen):
 # Screen glass and aluminium base share perspective, making the target a physical laptop.
 a,b,c,d=q
 outer=[(a[0]-15,a[1]-16),(b[0]+15,b[1]-16),(c[0]+15,c[1]+14),(d[0]-15,d[1]+14)]
 ImageDraw.Draw(im).polygon(outer,fill='#363a40')
 warp(im,screen,q)
 base=[(d[0]-15,d[1]+14),(c[0]+15,c[1]+14),(c[0]+92,c[1]+95),(d[0]-104,d[1]+95)]
 ImageDraw.Draw(im).polygon(base,fill='#b6b8b9')
 line(im,[base[2],base[3]],'#898d90',7)
 for i in range(4):
  yy=d[1]+25+i*12;line(im,[(d[0]+40-i*14,yy),(c[0]-28+i*9,yy)],'#919598',3)

def box(im,x,y,s=1,lift=0):
 # No logo on the hardware. Ownership label sits in space, not decoration.
 d=ImageDraw.Draw(im)
 xx=x;yy=y;ww=480*s;hh=91*s;deep=110*s
 d.polygon([(xx,yy),(xx+ww,yy),(xx+ww+deep,yy-deep*.52),(xx+deep,yy-deep*.52)],fill='#e1e1dd')
 d.polygon([(xx,yy),(xx+ww,yy),(xx+ww,yy+hh),(xx,yy+hh)],fill='#bfc1c0')
 d.polygon([(xx+ww,yy),(xx+ww+deep,yy-deep*.52),(xx+ww+deep,yy+hh-deep*.52),(xx+ww,yy+hh)],fill='#9b9e9e')
 rr(im,(xx+42*s,yy+39*s,xx+115*s,yy+48*s),3*s,'#60666b')
 circle(im,(xx+423*s,yy+40*s,xx+434*s,yy+51*s),GREEN)
 if lift:
  off=lift*63*s
  d.polygon([(xx,yy-off),(xx+ww,yy-off),(xx+ww+deep,yy-off-deep*.52),(xx+deep,yy-off-deep*.52)],fill='#e6e6e2')
  line(im,[(xx,yy-off),(xx+ww,yy-off)],'#a4a8a7',max(1,round(2*s)))

def frame(t):
 im=Image.new('RGBA',(W,H),PAPER)
 intro=p(t,.72,2.02);end=p(t,6.63,8.58)
 # Background turns ink only when the guest has filled the view; it returns on access reveal.
 bg=col(PAPER,'#d9dad6',intro*(1-end));im.paste(bg,(0,0,W,H))
 # Large cast grounding shadows, rendered as soft layers rather than glow.
 shadow=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(shadow)
 sd.ellipse((132,850,1040,948),fill=(31,34,35,38));sd.ellipse((1110,824,1770,925),fill=(31,34,35,38));shadow=shadow.filter(ImageFilter.GaussianBlur(22));im.alpha_composite(shadow)
 startq=[(152,360),(947,318),(967,813),(180,835)]
 endq=[(150,266),(1170,288),(1165,859),(185,857)]
 lq=lerpq(startq,endq,end)
 # Early camera tracks across the desk, not through stacked cards.
 lq=[(x-1800*intro*(1-end),y+100*intro*(1-end)) for x,y in lq]
 laptop(im,lq,browser(t,True) if t>6.6 else SILO)
 rx=mix(1188,1330,end)+400*intro*(1-end);ry=mix(821,842,end)+530*intro*(1-end)
 box(im,rx,ry,mix(.86,.72,end),p(t,.2,1.0)*(1-end))
 remoteq=[(1200,417),(1710,372),(1710,719),(1200,764)]
 fullq=[(83,84),(1837,84),(1837,1012),(83,1012)]
 finalq=[(1329,500),(1740,485),(1740,739),(1329,755)]
 q=lerpq(remoteq,fullq,intro)
 # End: camera pulls out of remote screen to show BOTH views of the same running site.
 q=lerpq(q,finalq,end)
 # A physical split at the owner's lid reveals the virtual interior.
 # The visible guest stays attached to the right-hand computer all the way out.
 rim=[(q[0][0]-5,q[0][1]-5),(q[1][0]+5,q[1][1]-5),(q[2][0]+5,q[2][1]+5),(q[3][0]-5,q[3][1]+5)]
 ImageDraw.Draw(im).polygon(rim,fill='#999e9e')
 warp(im,guest(t),q)
 if intro<.96:
  a=1-p(t,.72,1.28)
  overlay=Image.new('RGBA',(W,H));text(overlay,(181,207),'Your laptop',48,INK,True);text(overlay,(1210,230),'Office Mac',48,INK,True)
  text(overlay,(1210,290),'Linux VM',31,'#757970')
  overlay.putalpha(overlay.getchannel('A').point(lambda x:round(x*a)));im.alpha_composite(overlay)
 # Silo's connected port bridges the remote owner and the laptop; a continuous wire is causal.
 if end>0:
  over=Image.new('RGBA',(W,H));d=ImageDraw.Draw(over)
  # Connecting path runs behind the spatially separated endpoints.
  line(over,[(1250,835),(1250,945),(940,945),(940,909)],'#777e83',3)
  n=p(t,7.0,8.22)
  # No traveling machine: only the endpoint becomes available.
  rr(over,(642,937,1248,1009),15,'#fbfbf8','#cccfc9',2)
  text(over,(675,958),'3000',28,INK,mono=True)
  circle(over,(789,963,803,977),GREEN);text(over,(824,958),'127.0.0.1:3000',28,'#535d65',mono=True)
  over.putalpha(over.getchannel('A').point(lambda x:round(x*end)));im.alpha_composite(over)
 if t>8.35:
  a=p(t,8.35,9.03);over=Image.new('RGBA',(W,H))
  text(over,(149,143),'Your laptop',44,INK,True);text(over,(1324,329),'Office Mac',41,INK,True)
  text(over,(1324,386),'studio  ·  Running',28,'#737b7a')
  over.putalpha(over.getchannel('A').point(lambda x:round(x*a)));im.alpha_composite(over)
 return im.convert('RGB')

TIMES=[0,.8,1.5,2.25,3.1,3.65,4.3,4.75,5.6,6.9,7.7,8.65,10]
for ti in TIMES:frame(ti).save(OUT/f'still-{ti:05.2f}.jpg',quality=92)
thumbs=[]
for ti in TIMES:
 f=frame(ti).resize((480,270),Image.Resampling.LANCZOS);text(f,(12,10),f'{ti:04.2f}s',17,'#8f9499',True);thumbs.append(f)
sheet=Image.new('RGB',(1920,1080),'#eee')
for i,f in enumerate(thumbs):sheet.paste(f,((i%4)*480,(i//4)*270))
sheet.save(OUT/'contact-sheet.jpg',quality=93)
if '--stills' in sys.argv:sys.exit()
cmd=['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'silo-animatic.mp4')]
log=open(OUT/'encode.log','w');proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=log)
for i in range(round(DURATION*FPS)):
 proc.stdin.write(frame(i/FPS).tobytes())
 if i%120==0:print(f'{i}/{round(DURATION*FPS)}',flush=True)
proc.stdin.close();proc.wait();log.close()
if proc.returncode:raise RuntimeError('ffmpeg failed; see encode.log')
print(OUT/'silo-animatic.mp4')

"""B: independent workspaces. Disposable 10.8s, deterministic, seekable animatic.
Run: bundled-python animatic_b.py [--stills]. Illustration only, no live VM use.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
from pathlib import Path
import math,subprocess,sys
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'render-b';OUT.mkdir(exist_ok=True)
W,H=1920,1080;FPS=60;DURATION=10.8
INK='#202329';PAPER='#efefeb';ORANGE='#ff9f0a';GREEN='#238364'
fonts={}
def font(n,b=False,m=False):
 k=(round(n),b,m)
 if k not in fonts:fonts[k]=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc' if m else '/System/Library/Fonts/HelveticaNeue.ttc',round(n),index=0 if m else int(b))
 return fonts[k]
def txt(im,x,y,s,n=32,c=INK,b=False,m=False,a=None):ImageDraw.Draw(im).text((x,y),s,font=font(n,b,m),fill=c,anchor=a)
def rr(im,box,r,c,o=None,w=1):ImageDraw.Draw(im).rounded_rectangle(box,r,fill=c,outline=o,width=w)
def ln(im,pts,c,w=2):ImageDraw.Draw(im).line(pts,fill=c,width=w,joint='curve')
def el(im,box,c):ImageDraw.Draw(im).ellipse(box,fill=c)
def ease(t):t=max(0,min(1,t));return t*t*t*(t*(6*t-15)+10)
def p(t,a,b):return ease((t-a)/(b-a))
def lerp(a,b,t):return a+(b-a)*t
def quad(a,b,t):return [(lerp(x,u,t),lerp(y,v,t)) for (x,y),(u,v) in zip(a,b)]
def warp(im,src,q):
 A=[];B=[]
 for (x,y),(u,v) in zip(q,[(0,0),(src.width,0),(src.width,src.height),(0,src.height)]):
  A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);B.extend([u,v])
 c=np.linalg.solve(np.array(A),np.array(B));im.alpha_composite(src.transform((W,H),Image.Transform.PERSPECTIVE,c,Image.Resampling.BICUBIC))
def human(im,x,y):
 pts=[(0,0),(0,36),(10,26),(19,44),(26,40),(17,22),(32,22)]
 ImageDraw.Draw(im).polygon([(x+a,y+b) for a,b in pts],fill='#fdfdfb',outline='#22262b',width=2)
CURSOR=Image.open(ROOT/'assets/codex-agent-cursor.png').convert('RGBA')
def agent(im,x,y):
 c=CURSOR.resize((42,44),Image.Resampling.LANCZOS)
 glow=Image.new('RGBA',(68,70),'#339cff');mask=Image.new('L',(68,70));mask.paste(c.getchannel('A'),(13,13));mask=mask.filter(ImageFilter.GaussianBlur(6));glow.putalpha(mask.point(lambda a:min(180,a*2)))
 im.alpha_composite(glow,(round(x)-13,round(y)-13));im.alpha_composite(c,(round(x),round(y)))
def server(im,x,y,c='#5f6771'):
 for yy in [y,y+23]:rr(im,(x,yy,x+40,yy+15),3,None,c,2);el(im,(x+7,yy+5,x+11,yy+9),c)
def mark(im,x,y,s):
 for r,start,end,c in [(.46,28,276,INK),(.305,110,372,INK),(.153,155,425,ORANGE)]:ImageDraw.Draw(im).arc((x+s*(.5-r),y+s*(.5-r),x+s*(.5+r),y+s*(.5+r)),start,end,fill=c,width=max(2,round(s*.082)))
def check(im,x,y,s=1,c=GREEN):ln(im,[(x,y+10*s),(x+10*s,y+20*s),(x+31*s,y-5*s)],c,max(2,round(5*s)))

def notes(t):
 im=Image.new('RGBA',(800,780),'#fcfcf9');d=ImageDraw.Draw(im)
 rr(im,(0,0,800,66),0,'#f1f1ed');txt(im,38,19,'Notes',25,'#656b71',True)
 for x in [680,713,746]:el(im,(x,27,x+11,38),'#b7bcb9')
 txt(im,60,105,'Today',67,INK,True)
 txt(im,62,197,'One thing at a time.',27,'#7c8383')
 # Human continues a drag while the guest consumes its own entire workspace.
 drag=p(t,1.72,3.04);cy=lerp(282,598,drag)
 if t<3.12:
  rr(im,(58,282,742,395),13,'#f2f2ee','#e3e5df',2)
  txt(im,88,324,'Release notes',37,'#b4bab5',True)
 remaining_y=lerp(414,282,p(t,3.12,3.7))
 rr(im,(58,remaining_y,742,remaining_y+113),13,'#f3f3ef')
 txt(im,89,remaining_y+39,'Record demo',37,'#646e6a',True)
 txt(im,60,556,'DONE',23,'#7b8681',True)
 if drag>0:
  rr(im,(58,598,742,711),13,'#e8eeea','#bdcdc2',2)
 # Dragged item remains a stable physical object during simultaneous action.
 dx=14*math.sin(math.pi*drag)
 rr(im,(58+dx,cy,742+dx,cy+113),13,'#fffefa','#c4cbc3',2)
 if drag>.99:
  check(im,89,cy+49,1.1);txt(im,146,cy+35,'Release notes',37,INK,True)
 else:txt(im,89+dx,cy+35,'Release notes',37,INK,True)
 hx=lerp(660,560,p(t,.75,1.7))+dx;hy=lerp(228,340,p(t,.75,1.7))+316*drag
 if t>3.3:hx=lerp(hx,603,p(t,3.3,4.1));hy=lerp(hy,485,p(t,3.3,4.1))
 human(im,hx,hy)
 return im

def report(t,w=810,h=624):
 im=Image.new('RGBA',(w,h),'#fefdf9');d=ImageDraw.Draw(im)
 rr(im,(0,0,w,63),0,'#f4f4f0');txt(im,30,20,'reports.local',21,'#676f72',m=True)
 # Explicit browser maximize target.
 rr(im,(w-85,20,w-61,44),3,None,'#697276',2);ln(im,[(w-40,24),(w-24,40)],'#697276',2);ln(im,[(w-24,24),(w-40,40)],'#697276',2)
 txt(im,43,96,'Weekly report',48,INK,True)
 last=t>=4.35
 rr(im,(43,172,358,237),9,'#f0f0e9','#d8dcd3',2)
 txt(im,63,190,'Last week' if last else 'This week',30,INK,True)
 ln(im,[(314,198),(326,210),(338,198)],'#67716e',3)
 # Quantitative consequence of choosing the requested period, not decoration.
 chart_top=278;chart_bottom=h-133;chart_h=max(80,chart_bottom-chart_top)
 vals=[lerp(a,b,p(t,4.35,4.9)) for a,b in zip([.36,.75,.51],[.8,.45,.91])]
 widths=(w-150)/3
 for i,v in enumerate(vals):
  x=55+i*widths;barh=chart_h*v
  rr(im,(x,chart_bottom-barh,x+widths-31,chart_bottom),8,ORANGE if last else '#b8c0b8')
  txt(im,x+8,chart_bottom+15,['Mon','Wed','Fri'][i],23,'#7e8680')
 if 3.66<t<4.35:
  # Native-looking two-item menu, large enough to read at half size.
  rr(im,(43,242,358,365),9,'#fffefa','#c2c8c1',2)
  txt(im,67,253,'This week',28,'#727b75');rr(im,(51,304,350,357),6,'#e9eee8');txt(im,67,310,'Last week',28,INK,True)
 if t<5.6:
  rr(im,(w-300,h-88,w-42,h-27),10,INK)
  txt(im,w-171,h-59,'Export CSV',27,'#fffefa',True,a='mm')
 else:
  # Output is saved inside the guest, never passed to the human's Notes.
  rr(im,(30,h-98,w-30,h-17),11,'#e4eee6','#c2d5c4',2)
  check(im,53,h-67,.84);txt(im,103,h-78,'report.csv',32,INK,True);txt(im,w-57,h-61,'Saved',25,GREEN,a='rm')
 return im

def guest(t):
 im=Image.new('RGBA',(890,780),'#303a3f');d=ImageDraw.Draw(im)
 # This rail is the same Silo VM row that opened the workspace.
 rr(im,(0,0,890,92),0,'#fbfbf8');ln(im,[(0,91),(890,91)],'#a5afa9',2)
 server(im,26,24);txt(im,91,19,'studio',37,INK,True)
 rr(im,(247,25,446,63),18,'#eaece7');txt(im,346,44,'Office Mac',24,'#66726b',a='mm')
 el(im,(473,37,487,51),GREEN);txt(im,503,28,'Running',24,'#717c76')
 txt(im,849,45,'Linux',23,'#717c76',a='rm')
 # Browser grows only within the VM. No part can cross the rail or left boundary.
 grow=p(t,1.96,2.79)
 x=lerp(91,0,grow);y=lerp(218,92,grow);ww=round(lerp(704,890,grow));hh=round(lerp(468,688,grow))
 # Task belongs to the configured agent, before its browser takes the whole VM.
 if grow<1:
  txt(im,45,124,'Export last week’s report.',33,'#e7efeb',True)
 b=report(t,ww,hh);im.alpha_composite(b,(round(x),round(y)))
 # Blue official cursor performs maximize, select period, export.
 ax=lerp(600,721,p(t,1.0,1.93));ay=lerp(529,251,p(t,1.0,1.93))
 if t>=1.96:
  ax=lerp(721,245,p(t,2.83,3.57));ay=lerp(251,299,p(t,2.83,3.57))
 if t>=3.66:
  ax=245;ay=lerp(299,421,p(t,3.8,4.27))
 if t>=4.35:
  ax=lerp(245,751,p(t,4.73,5.43));ay=lerp(421,723,p(t,4.73,5.43))
 if t>=5.6:ax=lerp(751,809,p(t,5.6,6.0));ay=lerp(723,637,p(t,5.6,6.0))
 agent(im,ax,ay)
 return im

def chassis(im,q,kind,r):
 a,b,c,d=q;dr=ImageDraw.Draw(im)
 rimsize=lerp(1,12,r)
 rim=[(a[0]-rimsize,a[1]-rimsize),(b[0]+rimsize,b[1]-rimsize),(c[0]+rimsize,c[1]+rimsize),(d[0]-rimsize,d[1]+rimsize)]
 dr.polygon(rim,fill='#373e42')
 if kind=='laptop':
  base=[(d[0]-12*r,d[1]+13*r),(c[0]+12*r,c[1]+13*r),(c[0]+77*r,c[1]+89*r),(d[0]-89*r,d[1]+89*r)]
  dr.polygon(base,fill='#b9beba');ln(im,[base[2],base[3]],'#868e8a',5)
  for i in range(4):ln(im,[(d[0]+30-i*9,d[1]+(28+i*10)*r),(c[0]-18+i*8,c[1]+(28+i*10)*r)],'#8f9994',3)
 else:
  mx=(d[0]+c[0])/2;my=(d[1]+c[1])/2
  dr.polygon([(mx-35,my+12*r),(mx+35,my+12*r),(mx+43,my+94*r),(mx-43,my+94*r)],fill='#afb8b2')
  rr(im,(mx-123,my+89*r,mx+123,my+106*r),8,'#959f99')
  # Unbranded small host rests beside its screen, clearly separate from the laptop.
  rr(im,(c[0]-83,c[1]+57,c[0]+47,c[1]+105),8,'#c3c9c4','#a3ada6',2);el(im,(c[0]+23,c[1]+79,c[0]+31,c[1]+87),GREEN)

def frame(t):
 im=Image.new('RGBA',(W,H),PAPER);reveal=p(t,6.43,8.64)
 nq0=[(102,204),(872,204),(872,955),(102,955)]
 nq1=[(164,373),(997,338),(1010,844),(185,883)]
 gq0=[(940,204),(1828,204),(1828,982),(940,982)]
 gq1=[(1240,373),(1783,401),(1783,838),(1240,810)]
 nq=quad(nq0,nq1,reveal);gq=quad(gq0,gq1,reveal)
 # Desktop opening is not a dissolve: the original VM row is the expanding boundary.
 unfold=p(t,.1,1.35)
 if reveal:
  sh=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(sh);sd.ellipse((109,899,1095,1004),fill=(30,40,34,36));sd.ellipse((1130,897,1890,974),fill=(30,40,34,30));im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(24)))
  chassis(im,nq,'laptop',reveal);chassis(im,gq,'desktop',reveal)
 # Revealing the laptop also reveals the rest of its desktop. Preserve note proportions.
 nw=round(lerp(800,1280,reveal));local=Image.new('RGBA',(nw,780),'#e3e7e1');local.alpha_composite(notes(t),(0,0))
 if nw>875:
  rr(local,(831,32,nw-20,260),12,'#fbfbf8')
  mark(local,850,54,34);txt(local,898,57,'Silo',28,INK,True)
  if nw>1000:
   server(local,851,133);txt(local,909,128,'studio',29,INK,True);txt(local,851,191,'Office Mac',23,'#778477');el(local,(nw-62,194,nw-49,207),GREEN)
 warp(im,local,nq)
 if t<1.35:
  # Silo's surrounding pane visibly yields to the selected row as it becomes the rail.
  layer=Image.new('RGBA',(W,H));mark(layer,986,300,55);txt(layer,1058,299,'Silo',49,INK,True)
  layer.putalpha(layer.getchannel('A').point(lambda a:round(a*(1-p(t,.18,.78)))));im.alpha_composite(layer)
  rowy=lerp(444,204,unfold);bottom=lerp(558,982,unfold)
  # Reveal guest contents by cropping, not scaling text vertically.
  height=round(bottom-rowy)
  panel=Image.new('RGBA',(890,max(92,height)),'#303a3f')
  whole=guest(t);panel.alpha_composite(whole.crop((0,0,890,min(780,height))))
  q=[(940,rowy),(1828,rowy),(1828,bottom),(940,bottom)]
  warp(im,panel,q)
 else:warp(im,guest(t),gq)
 # Traceable rail / boundary, continuous from Silo row to remote computer.
 if t>=1.35 and reveal<1:
  ln(im,[(gq[0][0]-4,gq[0][1]),(gq[3][0]-4,gq[3][1])],'#738178',4)
 # Brief identity labels carry the relationship rather than narrating the clicks.
 txt(im,lerp(104,164,reveal),lerp(107,252,reveal),'Your desktop' if reveal<.55 else 'Your laptop',53,INK,True)
 if t<6.43:
  txt(im,940,107,'Agent’s computer',53,INK,True)
 else:
  txt(im,lerp(940,1240,reveal),lerp(107,268,reveal),'Office Mac' if reveal>.55 else 'Agent’s computer',49,INK,True)
  if reveal>.8:txt(im,1241,329,'studio · Linux VM',27,'#758278')
 return im.convert('RGB')

TIMES=[0,.65,1.35,1.97,2.35,2.9,3.55,4.15,4.9,5.75,6.6,7.65,8.7,10.1]
for t in TIMES:frame(t).save(OUT/f'still-{t:05.2f}.jpg',quality=93)
sheet=Image.new('RGB',(1920,1080),PAPER)
for i,t in enumerate(TIMES):
 f=frame(t).resize((480,270),Image.Resampling.LANCZOS);txt(f,10,10,f'{t:.2f}s',16,'#77877c',True);sheet.paste(f,((i%4)*480,(i//4)*270))
sheet.save(OUT/'contact-sheet.jpg',quality=94)
if '--stills' in sys.argv:sys.exit()
log=open(OUT/'encode.log','w');proc=subprocess.Popen(['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'silo-b-animatic.mp4')],stdin=subprocess.PIPE,stderr=log)
for i in range(round(FPS*DURATION)):
 proc.stdin.write(frame(i/FPS).tobytes())
 if i%120==0:print(f'{i}/{round(FPS*DURATION)}',flush=True)
proc.stdin.close();proc.wait();log.close()
if proc.returncode:raise RuntimeError('ffmpeg failed')
print(OUT/'silo-b-animatic.mp4')

"""B2: the VM row opens a second computer. Disposable 7.8s, deterministic, seekable animatic.
Run: bundled-python animatic_b.py [--stills]. Illustration only, no live VM use.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
from pathlib import Path
import math,subprocess,sys
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'render-b2';OUT.mkdir(exist_ok=True)
W,H=1920,1080;FPS=60;DURATION=7.8
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

def notes2(t,w):
 im=Image.new('RGBA',(w,1080),'#fbfbf7');d=ImageDraw.Draw(im)
 s=min(1,w/1030);x=75*s;right=w-75*s
 rr(im,(0,0,w,82),0,'#f0f1eb');txt(im,x,25,'Notes',29,'#66736b',True)
 for xx in [w-121,w-88,w-55]:el(im,(xx,34,xx+11,45),'#b9c3b9')
 txt(im,x,143,'Today',round(142*s),INK,True)
 txt(im,x,312,'TO DO',round(26*max(.8,s)),'#899287',True)
 drag=p(t,1.73,2.5);cy=lerp(370,801,drag)
 rest=lerp(538,370,p(t,2.56,2.94))
 rr(im,(x,rest,right,rest+134),12,'#eeefe7');txt(im,x+27,rest+39,'Record demo',round(54*s),'#737f72',True)
 if t<2.55:
  rr(im,(x,370,right,504),12,'#f1f2eb');txt(im,x+27,409,'Release notes',round(54*s),'#b1baad',True)
 txt(im,x,738,'DONE',round(26*max(.8,s)),'#7d8b7b',True)
 if drag>0:rr(im,(x,801,right,935),12,'#e8eee4','#cad6c4',2)
 rr(im,(x,cy,right,cy+134),12,'#fffefa','#cbd1c4',2)
 if drag>.999:
  check(im,x+27,cy+58,1.0);txt(im,x+81,cy+41,'Release notes',round(49*s),INK,True)
 else:txt(im,x+27,cy+40,'Release notes',round(54*s),INK,True)
 hx=lerp(min(w-90,830),min(w-80,330),p(t,.9,1.73));hy=lerp(310,433,p(t,.9,1.73))+431*drag
 if t>2.56:hx=lerp(hx,w-85,p(t,2.56,3.0));hy=lerp(hy,550,p(t,2.56,3.0))
 human(im,hx,hy)
 return im

def guest2(t,w,h=1080):
 im=Image.new('RGBA',(w,h),'#263c38')
 # Persistent Silo row is both the generative object and the domain boundary.
 rr(im,(0,0,w,110),0,'#f4f5ef');ln(im,[(0,109),(w,109)],'#a1b09f',3)
 server(im,28,37);txt(im,93,25,'studio',43,INK,True)
 rr(im,(254,32,471,79),22,'#e5e9df');txt(im,363,55,'Office Mac',27,'#627560',a='mm')
 el(im,(501,48,517,64),GREEN);txt(im,535,37,'Running',26,'#6e806b')
 if w>1100:txt(im,w-37,56,'Linux desktop',28,'#6f806d',a='rm')
 grow=p(t,1.78,2.38)
 margin=lerp(132,0,grow);top=lerp(292,110,grow)
 bw=round(w-margin*2);bh=round(lerp(638,h-110,grow))
 if grow<.95:txt(im,132,168,'Export last week’s report.',45,'#e6eee2',True)
 # Skip incidental dropdown work: period is already selected; show one concrete result.
 b=report(5.1 if t<3.15 else 5.8,bw,bh)
 im.alpha_composite(b,(round(margin),round(top)))
 # Two deliberate gestures: maximize, then export. Their complete interval is <1.5s.
 ax=lerp(w-310,w-202,p(t,1.1,1.73));ay=lerp(670,325,p(t,1.1,1.73))
 if t>1.78:ax=lerp(w-202,w-182,p(t,2.43,2.96));ay=lerp(325,h-68,p(t,2.43,2.96))
 if t>3.15:ax=lerp(w-182,w-77,p(t,3.15,3.48));ay=lerp(h-68,h-155,p(t,3.15,3.48))
 agent(im,ax,ay)
 return im

def frame(t):
 im=Image.new('RGBA',(W,H),'#e8ede3')
 opening=p(t,.44,1.58);reveal=p(t,3.58,5.98)
 # Stage 1 is a single full-bleed human workspace; stage 2 is an unequal 28/72 split.
 human_w=round(lerp(1920,550,opening));guest_w=round(lerp(808,1370,opening))
 # During the final reveal, uncover a wider local desktop without stretching the note app.
 local_w=round(lerp(human_w,1280,reveal));note_w=round(lerp(human_w,830,reveal))
 local=Image.new('RGBA',(local_w,1080),'#dbe4d4');local.alpha_composite(notes2(t,note_w),(0,0))
 if local_w>note_w+140:
  xx=note_w+22;rr(local,(xx,26,local_w-23,298),11,'#f7f8f0')
  mark(local,xx+25,51,36);txt(local,xx+77,52,'Silo',31,INK,True)
  if local_w>note_w+285:
   server(local,xx+26,143);txt(local,xx+85,139,'studio',31,INK,True);txt(local,xx+27,219,'Office Mac',26,'#71846c')
 # One continuous geometric reveal: abstract edges acquire hardware and perspective.
 nq0=[(0,0),(human_w,0),(human_w,H),(0,H)]
 nq1=[(152,379),(860,332),(875,835),(176,884)]
 gq0=[(550,0),(1920,0),(1920,1080),(550,1080)]
 gq1=[(1029,308),(1795,357),(1795,837),(1029,785)]
 nq=quad(nq0,nq1,reveal);gq=quad(gq0,gq1,reveal)
 if reveal>0:
  sh=Image.new('RGBA',(W,H));sd=ImageDraw.Draw(sh);sd.ellipse((80,895,960,1011),fill=(26,46,26,35));sd.ellipse((925,883,1870,995),fill=(26,46,26,35));im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(25)))
  chassis(im,nq,'laptop',reveal);chassis(im,gq,'desktop',reveal)
 warp(im,local,nq)
 if opening<1:
  row_x=lerp(1060,550,opening);row_y=lerp(821,0,opening)
  bottom=lerp(932,1080,opening);ph=round(bottom-row_y)
  full=guest2(t,guest_w)
  panel=full.crop((0,0,guest_w,min(1080,ph)))
  # The trailing edge uncovers contents at natural scale rather than stretching a screenshot.
  q=[(row_x,row_y),(row_x+guest_w,row_y),(row_x+guest_w,bottom),(row_x,bottom)]
  warp(im,panel,q)
  if opening<.45:
   alpha=1-p(t,.44,.96);lay=Image.new('RGBA',(W,H));mark(lay,1061,749,42);txt(lay,1120,750,'Silo',39,INK,True);lay.putalpha(lay.getchannel('A').point(lambda a:round(a*alpha)));im.alpha_composite(lay)
 else:
  warp(im,guest2(t,1370),gq)
  if reveal<1:ln(im,[(gq[0][0]-3,gq[0][1]),(gq[3][0]-3,gq[3][1])],'#85967d',6)
 return im.convert('RGB')

TIMES=[0,.52,.85,1.22,1.65,1.99,2.4,2.85,3.25,3.9,4.65,5.4,6.1,7.3]
for t in TIMES:frame(t).save(OUT/f'still-{t:05.2f}.jpg',quality=94)
sheet=Image.new('RGB',(1920,1080),'#e8ede3')
for i,t in enumerate(TIMES):
 f=frame(t).resize((480,270),Image.Resampling.LANCZOS);txt(f,9,10,f'{t:.2f}s',16,'#7e8a78',True);sheet.paste(f,((i%4)*480,(i//4)*270))
sheet.save(OUT/'contact-sheet.jpg',quality=94)
if '--stills' in sys.argv:sys.exit()
log=open(OUT/'encode.log','w');proc=subprocess.Popen(['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'silo-b2-animatic.mp4')],stdin=subprocess.PIPE,stderr=log)
for i in range(round(FPS*DURATION)):
 proc.stdin.write(frame(i/FPS).tobytes())
 if i%120==0:print(f'{i}/{round(FPS*DURATION)}',flush=True)
proc.stdin.close();proc.wait();log.close()
if proc.returncode:raise RuntimeError('ffmpeg failed')
print(OUT/'silo-b2-animatic.mp4')

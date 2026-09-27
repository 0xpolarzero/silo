"""Original 120 BPM score and edit-synchronous sound design. No samples."""
from pathlib import Path
import json
import subprocess
import wave
import numpy as np

SR=48000
DURATION=36
B=60/120
rng=np.random.default_rng(260927)
mix=np.zeros((int(SR*DURATION),2),dtype=np.float32)
N=len(mix)

def clock(d): return np.arange(int(d*SR))/SR
def scene_time(t): return t if t < 2.7 else t-.5
def freq(note): return 440*2**((note-69)/12)
def add(s,when,gain=1.,pan=0.,echo=False):
    start=round(when*SR)
    if start<0 or start>=N:return
    n=min(len(s),N-start)
    mix[start:start+n]+=np.asarray(s[:n],dtype=np.float32)[:,None]*np.array([np.sqrt((1-pan)/2),np.sqrt((1+pan)/2)])*gain
    if echo:
        for dt,g in [(B*.75,.22),(B*1.5,.1),(B*2.25,.045)]:add(s,when+dt,gain*g,-pan,False)

def kick():
    t=clock(.43)
    phase=2*np.pi*(46*t+90*.027*(1-np.exp(-t/.027)))
    return np.sin(phase)*np.exp(-t*12)*(1-np.exp(-t*1100))+.08*rng.normal(0,1,len(t))*np.exp(-t*240)

def clap():
    t=clock(.26);n=rng.normal(0,1,len(t));hp=n-np.r_[0,n[:-1]]
    env=sum(np.exp(-np.maximum(t-d,0)*55)*(t>=d) for d in [0,.011,.023])
    return hp*.13*env+np.sin(2*np.pi*178*t)*np.exp(-t*40)*.15

def hat(opened=False):
    t=clock(.2 if opened else .055);n=rng.normal(0,1,len(t));n=n-np.r_[0,n[:-1]]
    return n*np.exp(-t*(30 if opened else 120))*.2

def bass(note,d=.34):
    t=clock(d);f=freq(note)
    s=np.sin(2*np.pi*f*t)+.22*np.sin(2*np.pi*f*2*t)+.07*np.sin(2*np.pi*f*3*t)
    return np.tanh(s*1.3)*(1-np.exp(-t*300))*np.exp(-t*6.2)

def pluck(note):
    t=clock(1.1);f=freq(note)
    s=sum(np.sin(2*np.pi*f*k*t+.06*k)*np.exp(-t*k*2)/k**1.8 for k in range(1,7))
    return s*(1-np.exp(-t*250))*np.exp(-t*5.5)

def whoosh(when,d=.31,reverse=False,gain=.18):
    t=clock(d);n=rng.normal(0,1,len(t));n=np.convolve(n,np.ones(17)/17,mode='same')
    env=np.sin(np.pi*t/d)**2
    ph=2*np.pi*(190*t+900*t*t/d)
    s=n*env+.055*np.sin(ph)*env
    if reverse:s=s[::-1]
    add(s,when,gain,-.35)
    add(s,when+.018,gain*.72,.5)

# Typography hits lead immediately; the first machine opens on bar two.
add(kick(),0,.7)
add(clap(),B,.7)
add(kick(),2*B,.9)
add(pluck(74),2*B,.18,-.3,True)
whoosh(1.48,.36,False,.38)

for beat in range(4,64):
    when=beat*B
    if 48<=beat<50:continue
    if beat%4 in [0,2]:add(kick(),when,.7)
    if beat%4 in [1,3]:add(clap(),when,.62)
    add(hat(beat%4==3),when+B*.5,.35,(-1)**beat*.4)
    if beat>=52:add(hat(),when+B*.75,.17,-.6)
    notes=[38,38,41,36,38,45,41,36]
    add(bass(notes[beat%8]),when,.32)
    if beat%4==2:add(bass(notes[beat%8],.18),when+B*.75,.18)

melody=[74,69,77,76,74,65,69,72]
for i in range(60):
    when=2+i*B
    if when>=scene_time(31.8) or 23.5<=when<24.5:continue
    add(pluck(melody[i%8]),when+B*.25,.12 if i%2 else .19,(-1)**i*.44,True)

# Editorial accents follow the scene clock, with the removed half-second hold
# folded out of the soundtrack timeline. Keep the musical bed continuous.
for scene in [3.3,9.2,14.55,19.15,21.1,31.3]:
    time=scene_time(scene)
    whoosh(time-.18,.3,False,.22)
for scene in [6.55,12.1,17.35,27.45]:
    time=scene_time(scene)
    add(pluck(81),time,.095,-.2,True)
for scene in [6.1,9.55,10.5,17.1,17.73,23.8,27.15]:
    time=scene_time(scene)
    t=clock(.04);s=np.sin(2*np.pi*1900*t)*np.exp(-t*155)
    add(s,time,.09 if scene in [23.8,27.15] else .115,.1)
# Key chatter follows the terminal command and checkout email entry.
for i in range(10):
    t=clock(.03);s=rng.normal(0,1,len(t))*np.exp(-t*175)
    add(s,scene_time(11)+i/12,.018,(-1)**i*.22)
for i in range(7):
    t=clock(.035);s=rng.normal(0,1,len(t))*np.exp(-t*145)
    add(s,scene_time(25.45)+i*.14,.012,(-1)**i*.2)
whoosh(scene_time(29.6),.65,True,.12)

# Resolve to a D-minor add-nine chord and leave room for the end card.
end=scene_time(31.8)
add(kick(),end,.87)
t=clock(4)
s=sum((np.sin(2*np.pi*freq(m)*t)+.12*np.sin(2*np.pi*freq(m)*2.001*t))/6 for m in [38,50,57,62,65,76])
s*=np.minimum(t/.016,1)*np.exp(-t*1.25)
add(s,end,.7,0,True)
add(pluck(86),end+.045,.11,-.2,True)

# Short stereo room; preserve transient clarity.
dry=mix.copy()
for seconds,gain in [(.037,.05),(.079,.036),(.121,.025),(.179,.015)]:
    d=int(seconds*SR);mix[d:]+=dry[:-d,::-1]*gain
mix=np.tanh(mix*1.05)
mix*=np.minimum(np.arange(N)/(SR*.006),1)[:,None]
mix*=np.minimum((N-np.arange(N))/(SR*.65),1)[:,None]
mix/=max(1.,np.max(np.abs(mix))/.9)
out=Path(__file__).parent/'output'
with wave.open(str(out/'score.wav'),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR);f.writeframes((mix*32767).astype('<i2').tobytes())

base=['ffmpeg','-hide_banner','-nostats','-y','-i',str(out/'score.wav')]
analysis=subprocess.run(base+['-af','loudnorm=I=-15:TP=-1.6:LRA=8:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
stats=json.JSONDecoder().raw_decode(analysis.stderr[analysis.stderr.rfind('{'):])[0]
flt=f"loudnorm=I=-15:TP=-1.6:LRA=8:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true"
subprocess.run(base+['-af',flt,'-ar','48000','-c:a','pcm_s24le',str(out/'score-master.wav')],capture_output=True,check=True)
(out/'audio-mastering.json').write_text(json.dumps(stats,indent=2)+'\n')
print('Original 36-second stereo score rendered and mastered; 120 BPM.')

"""Original 120 BPM electronic score; deterministic synthesis, no samples."""
from pathlib import Path
import wave
import numpy as np

SR = 48000
DURATION = 54
rng = np.random.default_rng(94027)
mix = np.zeros((DURATION * SR, 2), dtype=np.float32)

def add(signal, when, gain=1., pan=0., echoes=False):
    start = int(when * SR)
    if start >= len(mix): return
    n = min(len(signal), len(mix) - start)
    if n <= 0: return
    stereo = np.asarray(signal[:n], dtype=np.float32)[:, None] * np.array([np.sqrt((1-pan)/2), np.sqrt((1+pan)/2)]) * gain
    mix[start:start+n] += stereo
    if echoes:
        for offset, level in [(0.375, .25), (.75, .14), (1.125, .065)]:
            add(signal, when+offset, gain*level, -pan, False)

def hz(m): return 440 * 2 ** ((m-69)/12)
def clock(d): return np.arange(int(d*SR)) / SR

def pluck(m, length=2.2):
    t=clock(length);f=hz(m)
    env=(1-np.exp(-t*170))*np.exp(-t*3.3)
    return (np.sin(2*np.pi*f*t+1.4*np.sin(2*np.pi*f*2*t)*np.exp(-t*8))+.12*np.sin(2*np.pi*f*3*t))*env

def pad(notes, length):
    t=clock(length);out=np.zeros_like(t)
    for m in notes:
        f=hz(m)
        out += (np.sin(2*np.pi*f*t)+.24*np.sin(2*np.pi*f*2.001*t)+.17*np.sin(2*np.pi*f*.997*t)) / len(notes)
    return out * np.minimum(t/1.4,1) * np.minimum((length-t)/1.8,1)

chords=[[50,57,60,64,69],[46,53,57,60,65],[48,55,60,64,67],[45,52,55,59,64]]
for bar in range(13):
    start=bar*4
    ch=chords[bar%4]
    energy=.9 if start<8 else (1.15 if start<31 else .8 if start<39 else 1.1)
    add(pad(ch,6.8),start,.17*energy,(-1)**bar*.18)
    if start<48:
        for j,idx in enumerate([0,2,4,3,1,3,4,2]):
            beat=start+j*.5
            if beat<3 and j%2: continue
            if 45<=beat<48: continue
            add(pluck(ch[idx]+12),beat,.068*energy,(-1)**j*.38,True)

for when in np.arange(4.5,48,.5):
    if 31<=when<33 or 45<=when<48: continue
    t=clock(.4)
    phase=2*np.pi*(47*t+65*.032*(1-np.exp(-t/.032)))
    kick=np.sin(phase)*np.exp(-t*13)*(1-np.exp(-t*350))
    if int(when*2)%2==0: add(kick,when,.36)
    else:
        n=rng.normal(0,1,len(t)); high=n-np.concatenate(([0],n[:-1]))
        snap=(high*.3+np.sin(2*np.pi*183*t)*.24)*np.exp(-t*38)*(1-np.exp(-t*1100))
        add(snap,when,.115,.12)

for when in np.arange(8.5,48,.25):
    if 31<=when<33 or 45<=when<48:continue
    t=clock(.065);n=rng.normal(0,1,len(t));h=n-np.concatenate(([0],n[:-1]))
    add(h*np.exp(-t*90),when,.019 if round(when*4)%2 else .031,(-1)**int(when*4)*.5)

for when in np.arange(8.5,45,1.):
    if 31<=when<33:continue
    m=chords[int(when/4)%4][0]-12;t=clock(.83);f=hz(m)
    bass=(np.sin(2*np.pi*f*t)+.17*np.sin(2*np.pi*2*f*t))*np.minimum(t/.015,1)*np.exp(-t*3.1)
    add(bass,when,.21)

# Soft reverse swells, logo chimes, and punctuation tied to the edit.
for when in [4.5,8.5,15,22,31,39,45,48]:
    t=clock(.8);n=rng.normal(0,1,len(t));n=np.convolve(n,np.ones(28)/28,mode='same')
    swell=n*np.sin(np.pi*t/.8)**2*np.linspace(.12,1,len(t))
    add(swell,when-.65,.115,-.15)
    add(pluck(81 if when==48 else 74,1.5),when,.065,.3,True)
for when,m in [(45,50),(46,57),(47,62)]:add(pluck(m,1.5),when,.15,0,True)
add(pad([50,57,60,64,69,74],6.0),48,.3)
add(pluck(86,4),48.5,.05,.35,True)

mix=np.tanh(mix*1.3)
fadein=np.minimum(np.arange(len(mix))/(SR*.5),1)
fadeout=np.minimum((len(mix)-np.arange(len(mix)))/(SR*2.4),1)
mix *= (fadein*fadeout)[:,None]
mix /= max(1.,np.max(np.abs(mix))/.82)
dest=Path(__file__).parent/'output'/'score.wav'
with wave.open(str(dest),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR);f.writeframes((mix*32767).astype('<i2').tobytes())
print(f'Original score: {DURATION}s, stereo, {SR} Hz; peak {np.max(np.abs(mix)):.3f}')

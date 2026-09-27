from pathlib import Path
import json
import subprocess
import numpy as np
p=Path(__file__).parent/'output'
video=p/'silo-computers-directed.mp4'
command=['ffmpeg','-v','error','-i',str(video),'-vf','scale=256:144,format=gray','-f','rawvideo','-pix_fmt','gray','-']
proc=subprocess.Popen(command,stdout=subprocess.PIPE)
size=256*144
previous=None
diffs=[]
while True:
    data=proc.stdout.read(size)
    if not data:break
    if len(data)!=size:raise RuntimeError('Incomplete decoded frame')
    frame=np.frombuffer(data,dtype=np.uint8).astype(np.int16)
    diffs.append(0 if previous is None else float(np.mean(np.abs(frame-previous))))
    previous=frame
assert proc.wait()==0
assert len(diffs)==2025
windows=[('scope_to_host',6.45,7.65),('laptop_to_workspace',10.45,11.75),('editor_to_network',14.75,15.7),('terminal_to_app',17.65,18.4),('app_to_agent',20.25,21.4),('checkout_result',24.45,25.15)]
report={'frames':len(diffs),'method':'Mean absolute difference in decoded 256x144 grayscale frames. A candidate exceeds 3× both neighbours plus 0.15 intensity levels. Heuristic, not proof of visual quality.','windows':[]}
for name,start,end in windows:
    a,b=int(start*60),int(end*60)
    candidates=[{'time':round(i/60,4),'difference':round(diffs[i],4),'previous':round(diffs[i-1],4),'next':round(diffs[i+1],4)} for i in range(a,b) if diffs[i]>max(diffs[i-1],diffs[i+1])*3+.15]
    report['windows'].append({'name':name,'start':start,'end':end,'max_difference':round(max(diffs[a:b]),4),'isolated_spike_candidates':candidates})
(p/'directed-motion-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))

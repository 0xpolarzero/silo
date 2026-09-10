"""Read-only release gate: every executable stays hardened and the VM can boot."""
from pathlib import Path
import plistlib
import subprocess
import sys

app=Path(sys.argv[1])
for name in ['silo-ui','msb','git','git-lfs','git-remote-http','git-remote-https']:
    executable=app/'Contents/MacOS'/name
    display=subprocess.run(['codesign','--display','--verbose=4',str(executable)],capture_output=True,check=True)
    if b'runtime' not in display.stderr:
        raise RuntimeError(f'{name} must retain hardened runtime.')
    result=subprocess.run(['codesign','--display','--entitlements',':-',str(executable)],capture_output=True,check=True)
    entitlements=plistlib.loads(result.stdout) if result.stdout.strip() else {}
    if name=='msb':
        if entitlements.get('com.apple.security.hypervisor') is not True or entitlements.get('com.apple.security.cs.disable-library-validation') is not True:
            raise RuntimeError('macOS runtime signing is not ready: the ad-hoc VM helper must have its reviewed, helper-only hypervisor/library-loading entitlements. Do not publish this build.')
    elif entitlements.get('com.apple.security.cs.disable-library-validation'):
        raise RuntimeError('Only the VM helper may have the library-loading exception.')

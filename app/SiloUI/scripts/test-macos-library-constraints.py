#!/usr/bin/env python3
"""Test macOS library constraints using disposable ad-hoc signed executables.

No installed app, production signing configuration, or existing VM is changed.
Requires macOS 14+, Xcode command-line tools, and Python 3. Optional runtime
proof requires a built Silo.app and its prepared guest-image directory.
Evidence is retained in --output (a new directory) or a unique /private/tmp
folder. A failed runtime cleanup retains its isolated MSB_HOME for inspection.
"""

import argparse
import gzip
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile


CONSTRAINT_REASON = "Library violates process' library load contraint"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class Commands:
    def __init__(self, output):
        self.output = output
        self.number = 0

    def __call__(self, *args, check=True, env=None, timeout=120):
        self.number += 1
        command = list(map(str, args))
        log = self.output / f"command-{self.number:03}.log"
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    env=env, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            log.write_text(f"Command: {command!r}\nTimed out: {error}\n")
            raise
        log.write_text(f"Command: {command!r}\nExit: {result.returncode}\n"
                       f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        if check:
            result.check_returncode()
        return result


def generic_probe(root, run, results, constraints_only=False):
    (root/'loader.c').write_text('''#include <dlfcn.h>
    #include <stdio.h>
    int main(int argc,char **argv) {
     if(argc!=2)return 2;
     void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
     if(!h){fprintf(stderr,"LOAD_REJECTED: %s\\n",dlerror());return 3;}
     int (*value)(void)=dlsym(h,"value");
     if(!value)return 4;
     printf("LOADED_VALUE=%d\\n",value());
     return 0;
    }
    ''')
    for name,value in [('approved',7),('replacement',9)]:
        (root/f'{name}.c').write_text(f'''#include <unistd.h>
    __attribute__((constructor)) static void init(void) {{ const char marker[]="INITIALIZER_{name.upper()}\\n"; write(2,marker,sizeof(marker)-1); }}
    int value(void) {{return {value};}}
    ''')
        run('clang','-dynamiclib',root/f'{name}.c','-o',root/f'{name}.dylib')
        run('codesign','--force','--sign','-','--identifier','org.silo.test.same-library',root/f'{name}.dylib')

    def cdhash(path):
        output=run('codesign','--display','--verbose=4',path).stderr
        return bytes.fromhex(re.search(r'^CDHash=(\w+)$',output,re.M)[1])

    (root/'exception.plist').write_bytes(plistlib.dumps({'com.apple.security.cs.disable-library-validation':True}))
    (root/'exact.coderequirement').write_bytes(plistlib.dumps({'cdhash':cdhash(root/'approved.dylib')}))
    run('codesign','--validate-constraint',root/'exact.coderequirement')
    run('clang',root/'loader.c','-o',root/'loader-original')
    for name,exception,constraint in [('strict',False,False),('unrestricted',True,False),('constrained',True,True)]:
        target=root/f'loader-{name}'
        shutil.copy2(root/'loader-original',target)
        args=['codesign','--force','--sign','-','--options','runtime']
        if exception:args+=['--entitlements',root/'exception.plist']
        if constraint:args+=['--enforce-constraint-validity','--library-constraint',root/'exact.coderequirement']
        run(*args,target)
        run('codesign','--verify','--strict',target)

    def case(name,loader,library,expected):
        if constraints_only and loader == 'loader-strict':
            results.append({'name': name, 'passed': False, 'skippedReason': 'Host signature control excluded by --constraints-only; requires separate full-suite proof.'})
            return
        if constraints_only and library == 'tampered.dylib':
            results.append({'name': name, 'passed': False, 'skippedReason': 'Host signature control excluded by --constraints-only; requires separate full-suite proof.'})
            return
        p=run(root/loader,root/library,check=False)
        if expected:
            value=9 if library=='replacement.dylib' else 7
            marker='REPLACEMENT' if value==9 else 'APPROVED'
            passed=p.returncode==0 and p.stdout==f'LOADED_VALUE={value}\n' and f'INITIALIZER_{marker}' in p.stderr
        else:
            if loader=='loader-strict':reason='Team ID'
            elif library=='unsigned.dylib':reason='unsigned library'
            elif library=='tampered.dylib':reason='code signature'
            else:reason=CONSTRAINT_REASON
            if library == 'tampered.dylib':
                # macOS may kill the loader while validating an executable page.
                # Signature failure and unchanged stored cdhash are checked below.
                passed = ((p.returncode == -9 or
                           (p.returncode == 3 and reason in p.stderr)) and
                          'INITIALIZER_' not in p.stdout + p.stderr)
            else:
                denied = reason in p.stderr or (library == 'unsigned.dylib' and CONSTRAINT_REASON in p.stderr)
                passed=p.returncode==3 and denied and 'INITIALIZER_' not in p.stdout+p.stderr
        results.append({'name':name,'passed':passed,'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr})

    case('strict rejects unsigned-developer library','loader-strict','approved.dylib',False)
    case('broad exception permits replacement','loader-unrestricted','replacement.dylib',True)
    case('constraint permits exact library','loader-constrained','approved.dylib',True)
    case('constraint rejects same-identifier replacement','loader-constrained','replacement.dylib',False)
    shutil.copy2(root/'approved.dylib',root/'approved-copy.dylib')
    case('constraint accepts identical bytes at another path','loader-constrained','approved-copy.dylib',True)
    shutil.copy2(root/'replacement.dylib',root/'unsigned.dylib')
    run('codesign','--remove-signature',root/'unsigned.dylib')
    case('constraint rejects unsigned replacement','loader-constrained','unsigned.dylib',False)

    tampered=root/'tampered.dylib'
    data=(root/'approved.dylib').read_bytes()
    require(data.count(b'INITIALIZER_APPROVED') == 1, 'Expected one tamper marker')
    tampered.write_bytes(data.replace(b'INITIALIZER_APPROVED',b'INITIALIZER_TAMPERED'))
    if not constraints_only:
        require(run('codesign','--verify','--strict',tampered,check=False).returncode != 0, 'Tampered library unexpectedly verifies')
    require(cdhash(tampered) == cdhash(root/'approved.dylib'), 'Tampering changed the stored cdhash')
    case('signature enforcement blocks changed bytes with original signature','loader-constrained','tampered.dylib',False)

    # Replace the actual approved pathname, using a new inode to avoid code-signing
    # cache artifacts. Names and identifiers cannot satisfy the content constraint.
    shutil.copy2(root/'replacement.dylib',root/'swap.dylib')
    os.replace(root/'swap.dylib',root/'approved.dylib')
    case('constraint rejects replacement at approved pathname','loader-constrained','approved.dylib',False)
    shutil.copy2(root/'approved-copy.dylib',root/'restore.dylib')
    os.replace(root/'restore.dylib',root/'approved.dylib')

    # Exercise dyld's recursive loading, not just the explicitly requested library.
    (root/'parent.c').write_text('extern int value(void); int parent_value(void){return value();}')
    run('clang','-dynamiclib',root/'parent.c',root/'approved.dylib','-o',root/'parent.dylib')
    run('codesign','--force','--sign','-',root/'parent.dylib')
    (root/'recursive.coderequirement').write_bytes(plistlib.dumps({'cdhash':{'$in':[cdhash(root/'approved.dylib'),cdhash(root/'parent.dylib')]}}))
    shutil.copy2(root/'loader-original',root/'loader-recursive')
    run('codesign','--force','--sign','-','--options','runtime','--entitlements',root/'exception.plist','--enforce-constraint-validity','--library-constraint',root/'recursive.coderequirement',root/'loader-recursive')
    case('constraint permits approved indirect dependency','loader-recursive','parent.dylib',True)
    shutil.copy2(root/'replacement.dylib',root/'swap.dylib')
    os.replace(root/'swap.dylib',root/'approved.dylib')
    case('constraint rejects replaced indirect dependency','loader-recursive','parent.dylib',False)
    shutil.copy2(root/'approved-copy.dylib',root/'restore.dylib')
    os.replace(root/'restore.dylib',root/'approved.dylib')

    # Ad-hoc signing cannot authenticate the complete loader against replacement.
    shutil.copy2(root/'loader-constrained',root/'loader-resigned')
    run('codesign','--force','--sign','-','--options','runtime','--entitlements',root/'exception.plist',root/'loader-resigned')
    case('whole-loader re-signing can remove the policy','loader-resigned','replacement.dylib',True)


def runtime_probe(root, run, bundle, guest, report):
    stage = root / 'runtime'
    stage.mkdir()
    helper = stage / 'msb'
    library = stage / 'libkrunfw.5.dylib'
    shutil.copy2(bundle / 'Contents/MacOS/msb', helper)
    shutil.copy2(bundle / 'Contents/Frameworks/libkrunfw.5.dylib', library)
    signature = run('codesign', '--display', '--verbose=4', library).stderr
    digest = bytes.fromhex(re.search(r'^CDHash=(\w+)$', signature, re.M)[1])
    constraint = stage / 'libraries.coderequirement'
    constraint.write_bytes(plistlib.dumps({'cdhash': digest}))
    entitlements = stage / 'entitlements.plist'
    entitlements.write_bytes(plistlib.dumps({
        'com.apple.security.hypervisor': True,
        'com.apple.security.cs.disable-library-validation': True,
    }))
    run('codesign', '--force', '--sign', '-', '--options', 'runtime',
        '--entitlements', entitlements, '--enforce-constraint-validity',
        '--library-constraint', constraint, helper)
    run('codesign', '--verify', '--strict', helper)
    home = Path(tempfile.mkdtemp(prefix='silo-lc-', dir='/private/tmp'))
    report['runtime'] = {'home': str(home), 'steps': [], 'cleanup': 'pending'}
    # A short unique home avoids macOS UNIX socket path limits. It never points
    # at the user's runtime, and only this home is eligible for removal.
    environment = dict(os.environ, MSB_HOME=str(home), MSB_PATH=str(helper),
                       MSB_LIBKRUNFW_PATH=str(library))
    created = False
    cleanup_ok = False

    def msb(name, *args, replacement=False, check=True):
        env = dict(environment)
        if replacement:
            env['MSB_LIBKRUNFW_PATH'] = str(root / 'replacement.dylib')
        result = run(helper, *args, env=env, timeout=300, check=False)
        (stage / f'{name}.log').write_text(result.stdout + '\n' + result.stderr)
        report['runtime']['steps'].append({
            'name': name, 'returncode': result.returncode,
            'stdout': result.stdout, 'stderr': result.stderr,
        })
        if check:
            result.check_returncode()
        return result

    try:
        manifest = json.loads((guest / 'manifest.json').read_text())
        archive = stage / 'image.tar'
        with gzip.open(guest / 'image.tar.gz', 'rb') as source, archive.open('wb') as target:
            shutil.copyfileobj(source, target)
        msb('load', 'image', 'load', '--input', archive,
            '--tag', manifest['imageReference'], '--quiet')
        # Set before invoking create so interruption after creation still takes
        # the exact isolated sandbox through the stop cleanup path.
        created = True
        msb('create', 'create', manifest['imageReference'], '--no-start',
            '--name', 'constraint-proof', '--cpus', '1', '--memory', '512M',
            '--net', 'none')
        msb('start-approved', 'start', 'constraint-proof')
        result = msb('exec-approved', 'exec', '--no-start', 'constraint-proof',
                     '--', 'sh', '-c', 'printf LIBRARY_CONSTRAINED_VM_OK')
        require('LIBRARY_CONSTRAINED_VM_OK' in result.stdout,
                'Approved VM did not return the expected execution marker')
        msb('stop-approved', 'stop', 'constraint-proof')
        result = msb('start-replacement', 'start', 'constraint-proof',
                     replacement=True, check=False)
        require(result.returncode != 0 and CONSTRAINT_REASON in result.stderr,
                'Replacement engine was not explicitly rejected by the library constraint')
        require('INITIALIZER_' not in result.stdout + result.stderr,
                'Replacement engine initializer executed')
        original_library = stage / 'approved-engine.dylib'
        shutil.copy2(library, original_library)
        replacement = stage / 'replacement-engine.dylib'
        shutil.copy2(root / 'replacement.dylib', replacement)
        identifier = re.search(r'^Identifier=(.+)$', signature, re.M)[1]
        run('codesign', '--force', '--sign', '-', '--identifier', identifier, replacement)
        try:
            os.replace(replacement, library)
            result = msb('start-replacement-same-path', 'start', 'constraint-proof', check=False)
            require(result.returncode != 0 and CONSTRAINT_REASON in result.stderr,
                    'Same-path replacement was not explicitly rejected by the library constraint')
            require('INITIALIZER_' not in result.stdout + result.stderr,
                    'Same-path replacement initializer executed')
        finally:
            # Restore the valid engine before any cleanup command may use it.
            os.replace(original_library, library)
        msb('start-restored', 'start', 'constraint-proof')
        result = msb('exec-restored', 'exec', '--no-start', 'constraint-proof',
                     '--', 'sh', '-c', 'printf RESTORED_VM_OK')
        require('RESTORED_VM_OK' in result.stdout,
                'Restored VM did not return the expected execution marker')
        # The final stop lives in finally so every exit after creation attempts
        # cleanup, including assertion failures and keyboard interruption.
    finally:
        if created:
            try:
                result = msb('stop-cleanup', 'stop', 'constraint-proof', check=False)
                cleanup_ok = result.returncode == 0
            except Exception as error:
                report['runtime']['cleanupError'] = str(error)
        else:
            cleanup_ok = True
        if cleanup_ok:
            shutil.rmtree(home)
            report['runtime']['cleanup'] = 'stopped; isolated home removed'
        else:
            report['runtime']['cleanup'] = 'failed; isolated home preserved'
            print(f'Cleanup failed. Isolated runtime retained at {home}', file=sys.stderr)
    require(cleanup_ok, 'Failed to stop the isolated runtime sandbox')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--constraints-only', action='store_true', help='Run nine library-constraint cases; skip two host signature controls, which require separate full-suite proof')
    parser.add_argument('--output', type=Path, help='New directory for retained evidence')
    parser.add_argument('--runtime-bundle', type=Path, help='Built Silo.app to copy for VM proof')
    parser.add_argument('--guest-image', type=Path, help='Prepared guest-image directory')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This proof requires macOS 14 or newer')
    if bool(args.runtime_bundle) != bool(args.guest_image):
        parser.error('--runtime-bundle and --guest-image must be provided together')
    if args.output:
        root = args.output.resolve()
        root.mkdir(parents=True, exist_ok=False, mode=0o700)
    else:
        root = Path(tempfile.mkdtemp(prefix='silo-library-proof-', dir='/private/tmp'))
    run = Commands(root)
    report = {'cases': [], 'passed': False, 'mode': 'constraints-only' if args.constraints_only else 'full'}
    print(f'Evidence: {root}', flush=True)
    try:
        sip = run('csrutil', 'status', check=False)
        report['sip'] = {'status': sip.stdout.strip(), 'stderr': sip.stderr.strip(), 'returncode': sip.returncode}
        report['os'] = run('sw_vers').stdout
        version = run('sw_vers', '-productVersion').stdout.strip()
        require(int(version.split('.')[0]) >= 14, 'Library constraints require macOS 14+')
        report['architecture'] = run('uname', '-m').stdout.strip()
        generic_probe(root, run, report['cases'], constraints_only=args.constraints_only)
        require(all(case['passed'] for case in report['cases'] if 'skippedReason' not in case), 'A library-constraint case failed')
        if args.runtime_bundle:
            runtime_probe(root, run, args.runtime_bundle.resolve(),
                          args.guest_image.resolve(), report)
        report['passed'] = True
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error) or type(error).__name__
        print(f'Failed: {report["error"]}', file=sys.stderr)
    finally:
        report['counts'] = {
            'passed': sum(case['passed'] for case in report['cases']),
            'skipped': sum('skippedReason' in case for case in report['cases']),
            'failed': sum(not case['passed'] and 'skippedReason' not in case for case in report['cases']),
            'total': len(report['cases']),
        }
        (root / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'{sum(case["passed"] for case in report["cases"])}/{len(report["cases"])} '
          f'library cases passed; {report["counts"]["skipped"]} skipped; {report["mode"]} overall {"PASS" if report["passed"] else "FAIL"}')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

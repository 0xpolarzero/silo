"""Export and restore reviewed public Cargo units for opt-in cache experiments.

Only credential-free trusted producers may export. Signing jobs restore only.
The context file must identify the exact public compiler/profile/SDK inputs.
"""
import argparse, hashlib, importlib.util, json, os, re, shutil, stat, sys, tarfile, tomllib
from pathlib import Path

SENTINELS = [b'SYNTHETIC-RELEASE-BOUNDARY-SENTINEL', b'SYNTHETIC-DEPENDENCY-ROTATION-SENTINEL', b'SILO_GITHUB_CLIENT_SECRET']
class CacheError(ValueError):
    pass

def require(valid, message):
    if not valid: raise CacheError(message)

HASH = re.compile(r'^[a-f0-9]{16}$')
SOURCE = 'registry+https://github.com/rust-lang/crates.io-index'

def digest(path, forbidden=()):
    h = hashlib.sha256()
    tail = b''
    markers = [*SENTINELS, *forbidden]
    overlap = max(map(len, markers)) - 1
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            value = tail + block
            if any(s in value for s in markers):
                raise ValueError(f'Forbidden configuration bytes in {path}')
            tail = value[-overlap:] if overlap else b''
            h.update(block)
    return h.hexdigest()

def export_units(target, messages, allow, destination, target_triple, forbidden):
    target, destination = target.resolve(), destination.absolute()
    require(not destination.exists(), "export destination must be new")
    records, selected, mapped = [], {}, set()
    for line in messages.read_text().splitlines():
        if not line.startswith('{'): continue
        try: record = json.loads(line)
        except json.JSONDecodeError: continue
        if record.get('reason') in ('compiler-artifact', 'build-script-executed'):
            records.append(record)
    require(records, 'no Cargo artifact inventory')
    def add(path, owner, reason):
        path = path.absolute()
        relative = path.relative_to(target)
        if '..' in relative.parts: raise ValueError('parent traversal')
        cursor = target
        for part in relative.parts:
            cursor /= part
            if cursor.is_symlink(): raise ValueError(f'symlink not allowed: {cursor}')
        if path.is_dir():
            for child in sorted(path.iterdir()): add(child, owner, reason)
        else:
            if not stat.S_ISREG(path.stat().st_mode): raise ValueError(f'not regular: {path}')
            old = selected.get(str(relative))
            if old and old['packageId'] != owner: raise ValueError('ambiguous artifact owner')
            selected[str(relative)] = {'packageId': owner, 'reason': reason}
    def profile(path):
        rel = path.relative_to(target)
        if rel.parts[:1] == ('release',): return target / 'release'
        if rel.parts[:2] == (target_triple, 'release'): return target / target_triple / 'release'
        raise ValueError(f'unexpected artifact profile: {path}')
    def unit(base, package, hashed_name):
        expected = package['name'] + '-'
        if not hashed_name.startswith(expected) or not HASH.fullmatch(hashed_name[len(expected):]):
            raise ValueError(f'unrecognized unit directory: {hashed_name}')
        folder = base / '.fingerprint' / hashed_name
        require(folder.is_dir(), f'missing fingerprint: {folder}')
        add(folder, package['id'], 'unit fingerprint')
    for record in records:
        identifier = record['package_id']
        if identifier not in allow: continue
        package = allow[identifier]
        require(package['source'] == SOURCE and package['id'] == identifier, 'unapproved package source')
        mapped.add(identifier)
        if record['reason']=='compiler-artifact':
            require(record['target']['name'] in package['targets'], 'unapproved package target')
        if record['reason'] == 'build-script-executed':
            out = Path(record['out_dir']); base = profile(out)
            require(out.name == 'out' and out.parent.parent == base/'build', 'invalid build output path')
            unit(base, package, out.parent.name)
            add(out.parent, identifier, 'public dependency build execution')
        elif 'custom-build' in record['target']['kind']:
            require(record['filenames'], 'missing artifact filenames')
            for filename in record['filenames']:
                path = Path(filename); base = profile(path)
                require(path.parent.parent == base/'build', 'invalid build executable path')
                unit(base, package, path.parent.name)
                add(path.parent, identifier, 'public dependency build executable')
        else:
            require(record['filenames'], 'missing artifact filenames')
            for filename in record['filenames']:
                path = Path(filename); base = profile(path)
                require(path.parent == base/'deps', f'unexpected dependency location: {path}')
                stem = path.name.split('.')[0]
                crate, sep, hash_value = stem.rpartition('-')
                require(sep and HASH.fullmatch(hash_value), f'invalid artifact name: {path}')
                require(crate.removeprefix('lib') == record['target']['name'].replace('-', '_'), f'unexpected crate name: {path}')
                unit(base, package, package['name']+'-'+hash_value)
                add(path, identifier, 'compiler artifact')
                dep = path.parent/(record['target']['name'].replace('-', '_')+'-'+hash_value+'.d')
                require(dep.is_file(), f'missing dep-info: {dep}')
                add(dep, identifier, 'compiler dep-info')
    require(mapped == set(allow), 'approved packages not emitted')
    require(selected, 'no public artifacts selected')
    manifest = []
    for relative, item in sorted(selected.items()):
        source = target/relative
        manifest.append({'path':relative,**item,'sha256':digest(source, forbidden),'bytes':source.stat().st_size,'mtimeNs':source.stat().st_mtime_ns,'mode':0o755 if source.stat().st_mode & 0o111 else 0o644})
    destination.mkdir()
    for entry in manifest:
        dest = destination/entry['path']; dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(target/entry['path'],dest)
    return manifest


def safe_relative(value):
    require(isinstance(value, str) and value and '\\' not in value and '\0' not in value, 'invalid relative path')
    path = Path(value)
    require(not path.is_absolute() and all(p not in ('', '.', '..') for p in value.split('/')), 'unsafe relative path')
    return path

def regular_tree(root):
    require(root.is_dir() and not root.is_symlink(), f'invalid directory: {root}')
    files = []
    for path in sorted(root.rglob('*')):
        require(not path.is_symlink(), f'symlink forbidden: {path}')
        require(path.is_dir() or stat.S_ISREG(path.stat().st_mode), f'special file forbidden: {path}')
        if path.is_file(): files.append(path)
    return files

def read_json(path):
    return json.loads(path.read_text())

def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def identities(args, metadata):
    require(re.fullmatch(r'[a-zA-Z0-9_-]+', args.target), 'invalid target triple')
    require(metadata.get('resolve') and metadata['resolve'].get('nodes'), 'metadata requires resolved dependencies')
    graph = sorted(metadata['resolve']['nodes'], key=lambda n: n['id'])
    lock_hash = file_hash(args.lockfile)
    context = read_json(args.context)
    mode = context.get('identityMode')
    require(mode in (None, 'semantic-root-version-v1'), 'unknown dependency identity mode')
    if mode == 'semantic-root-version-v1':
        spec = importlib.util.spec_from_file_location('dependency_identity', Path(__file__).with_name('cargo-dependency-identity.py'))
        identity = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(identity)
        resolution = identity.semantic_resolution(metadata, tomllib.loads(args.lockfile.read_text()))
        lock_hash = identity.identity_digest(resolution['lock'])
        graph = resolution['graph']
    return {'target': args.target, 'targetDir': str(args.target_dir.resolve()), 'cargoHome': str(args.cargo_home.resolve()),
            'contextSha256': file_hash(args.context), 'lockSha256': lock_hash,
            'graphSha256': hashlib.sha256(json.dumps(graph, sort_keys=True).encode()).hexdigest()}

def approve(metadata, lockfile, identifiers, cargo_home):
    packages = {p['id']: p for p in metadata['packages']}
    pins = {(p['name'], p['version'], p.get('source')): p.get('checksum') for p in tomllib.loads(lockfile.read_text())['package']}
    result = {}
    for identifier in sorted(identifiers):
        require(identifier in packages, 'unknown Cargo package ID')
        package = packages[identifier]
        if package.get('source') != SOURCE or identifier in metadata['workspace_members']: continue
        checksum = pins.get((package['name'], package['version'], package['source']))
        require(isinstance(checksum, str) and re.fullmatch(r'[a-f0-9]{64}', checksum), 'missing exact registry checksum')
        source = Path(package['manifest_path']).parent
        require(source.resolve().is_relative_to(cargo_home.resolve()/'registry/src'), 'registry source outside Cargo home')
        regular_tree(source)
        result[identifier] = {k: package[k] for k in ('id', 'name', 'version', 'source')}
        result[identifier].update(checksum=checksum, targets=[t['name'] for t in package['targets']], sourcePath=str(source.resolve()))
    require(result, 'no approved crates.io packages')
    return result

def source_inventory(package, cargo_home):
    source = Path(package['sourcePath'])
    archive = cargo_home/'registry/cache'/source.parent.name/(package['name']+'-'+package['version']+'.crate')
    require(file_hash(archive) == package['checksum'], 'registry archive checksum mismatch')
    expected = {}
    prefix = package['name']+'-'+package['version']
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            path = safe_relative(member.name.rstrip('/'))
            require(path.parts[0] == prefix and (member.isfile() or member.isdir()), 'unsafe registry archive member')
            if not member.isfile(): continue
            relative = str(Path(*path.parts[1:]))
            require(relative not in expected and relative != '.', 'duplicate registry source path')
            stream = tar.extractfile(member)
            require(stream is not None, 'missing registry member data')
            expected[relative] = hashlib.file_digest(stream, 'sha256').hexdigest()
    files = regular_tree(source)
    require({str(p.relative_to(source)) for p in files} == set(expected)|{'.cargo-ok'}, 'unexpected registry source file')
    require(read_json(source/'.cargo-ok') == {'v': 1}, 'invalid Cargo source marker')
    result=[]
    for path in files:
        relative=str(path.relative_to(source)); actual=file_hash(path)
        require(relative == '.cargo-ok' or actual == expected[relative], 'registry source differs from approved archive')
        result.append({'path':relative,'sha256':actual,'mtimeNs':path.stat().st_mtime_ns})
    directories=[{'path':str(p.relative_to(source)),'mtimeNs':p.stat().st_mtime_ns} for p in [source,*sorted(source.rglob('*'))] if p.is_dir()]
    return {'files':result,'directories':directories}

def cargo_records(path):
    records=[]
    for line in path.read_text().splitlines():
        if not line.startswith('{'): continue
        try: record=json.loads(line)
        except json.JSONDecodeError: continue
        if record.get('reason') in ('compiler-artifact','build-script-executed'):records.append(record)
    require(records, 'no Cargo artifact records')
    return records

def validate_artifact_path(relative, package, target):
    parts=safe_relative(relative).parts
    offset=1 if parts[:1]==('release',) else 2 if parts[:2]==(target,'release') else 0
    require(offset and len(parts)>offset+1, 'invalid cache profile path')
    kind=parts[offset]; name=parts[offset+1]
    if kind in ('build','.fingerprint'):
        prefix=package['name']+'-'
        require(name.startswith(prefix) and HASH.fullmatch(name[len(prefix):]), 'artifact package ownership mismatch')
    elif kind=='deps':
        require(len(parts)==offset+2, 'unexpected dependency subdirectory')
        stem=name.split('.')[0]; crate, _, unit=stem.rpartition('-')
        require(HASH.fullmatch(unit) and any(crate in (t.replace('-','_'),'lib'+t.replace('-','_')) for t in package['targets']), 'dependency target ownership mismatch')
    else: raise CacheError('only dependency unit directories may be restored')

def validate_cache(args, metadata):
    cache=args.cache_dir
    require(cache.is_dir() and not cache.is_symlink(), 'invalid cache directory')
    cache_files=regular_tree(cache)
    manifest=read_json(cache/'manifest.json')
    require(manifest.get('schemaVersion')==1 and manifest.get('identity')==identities(args,metadata), 'cache build identity mismatch')
    approved=approve(metadata,args.lockfile,manifest['packages'],args.cargo_home)
    require(manifest['packages']==approved, 'cache package approval mismatch')
    require(set(manifest['sources'])==set(approved), 'missing source inventory')
    selected=manifest['artifacts']; require(selected, 'empty artifact inventory')
    paths=set()
    for item in selected:
        relative=item['path']; require(relative not in paths, 'duplicate cached path'); paths.add(relative)
        require(item['packageId'] in approved, 'unapproved cached artifact')
        validate_artifact_path(relative,approved[item['packageId']],args.target)
        path=cache/'artifacts'/safe_relative(relative)
        require(item['mode'] in (0o644,0o755) and type(item['mtimeNs']) is int and 0 <= item['mtimeNs'] <= 2**63-1, 'invalid cached file metadata')
        require(path.is_file() and not path.is_symlink() and path.stat().st_size==item['bytes'] and digest(path,args.forbidden)==item['sha256'], 'cache artifact integrity mismatch')
    actual={str(p.relative_to(cache)) for p in cache_files}
    require(actual=={'manifest.json'}|{'artifacts/'+p for p in paths}, 'unlisted cache files')
    # Validate every source before adjusting any timestamps or copying artifacts.
    changes=[]
    for identifier, package in approved.items():
        source=Path(package['sourcePath']); inventory=manifest['sources'][identifier]
        files=regular_tree(source)
        expected={item['path'] for item in inventory['files']}
        require({str(p.relative_to(source)) for p in files}==expected, 'registry source inventory changed')
        for item in inventory['files']:
            path=source/safe_relative(item['path'])
            require(file_hash(path)==item['sha256'], 'registry source content changed')
            require(type(item['mtimeNs']) is int and 0 <= item['mtimeNs'] <= 2**63-1, 'invalid source timestamp')
            changes.append((path,item['mtimeNs']))
        directories={str(p.relative_to(source)) for p in [source,*source.rglob('*')] if p.is_dir()}
        require(directories=={i['path'] for i in inventory['directories']}, 'source directory inventory changed')
        for item in inventory['directories']:
            path=source if item['path']=='.' else source/safe_relative(item['path'])
            require(type(item['mtimeNs']) is int and 0 <= item['mtimeNs'] <= 2**63-1, 'invalid directory timestamp')
            changes.append((path,item['mtimeNs']))
    return manifest, changes

def perform(args):
    metadata=read_json(args.metadata)
    if args.command=='export':
        require(not args.cache_dir.exists(), 'cache destination must be new')
        records=cargo_records(args.messages)
        ids={r['package_id'] for r in records}
        approved=approve(metadata,args.lockfile,ids,args.cargo_home)
        sources={key:source_inventory(package,args.cargo_home) for key,package in approved.items()}
        args.cache_dir.mkdir(parents=True)
        artifacts=export_units(args.target_dir,args.messages,approved,args.cache_dir/'artifacts',args.target,args.forbidden)
        manifest={'schemaVersion':1,'identity':identities(args,metadata),'packages':approved,'sources':sources,'artifacts':artifacts}
        (args.cache_dir/'manifest.json').write_text(json.dumps(manifest,sort_keys=True))
        validate_cache(args,metadata)
    else:
        if args.command=='restore':
            require(not args.target_dir.exists() or not any(args.target_dir.iterdir()), 'restore target must be empty')
        manifest,changes=validate_cache(args,metadata)
        if args.command=='restore':
            for path, timestamp in changes:
                if path.stat().st_mtime_ns!=timestamp:os.utime(path,ns=(path.stat().st_atime_ns,timestamp),follow_symlinks=False)
            args.target_dir.mkdir(parents=True,exist_ok=True)
            for item in manifest['artifacts']:
                relative=safe_relative(item['path']); destination=args.target_dir/relative
                destination.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(args.cache_dir/'artifacts'/relative,destination)
                os.chmod(destination,item['mode'])
                os.utime(destination,ns=(item['mtimeNs'],item['mtimeNs']))
    return {'command':args.command,'packages':len(manifest['packages']),'files':len(manifest['artifacts']),
            'bytes':sum(i['bytes'] for i in manifest['artifacts']),'sourceFiles':sum(len(v['files']) for v in manifest['sources'].values()),'workspaceAndPathPackagesCached':0}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['export','restore','audit'])
    for name in ('metadata','lockfile','context','target-dir','cargo-home','cache-dir'):parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--target',required=True)
    parser.add_argument('--messages',type=Path)
    parser.add_argument('--forbid',action='append',default=[])
    parser.add_argument('--report',type=Path)
    args=parser.parse_args();args.forbidden=[v.encode() for v in args.forbid]
    try:
        require(args.command!='export' or args.messages is not None, 'export requires Cargo JSON messages')
        result=perform(args)
        if args.report:args.report.write_text(json.dumps(result,sort_keys=True)+'\n')
        print(json.dumps(result,sort_keys=True))
        return 0
    except (OSError,ValueError,KeyError,TypeError,tarfile.TarError) as error:
        print(f'Dependency cache rejected: {error}',file=sys.stderr)
        return 1

if __name__=='__main__':sys.exit(main())

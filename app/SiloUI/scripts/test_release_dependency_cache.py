"""Exercise dependency-cache boundaries using complete tiny Cargo/registry fixtures."""
import argparse, hashlib, importlib.util, io, json, os, shutil, tarfile, tempfile, unittest
from pathlib import Path

SPEC=importlib.util.spec_from_file_location('cache',Path(__file__).with_name('cargo-dependency-cache.py'))
CACHE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(CACHE)

class DependencyCacheTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name).resolve();self.home=self.root/'cargo';self.target=self.root/'target';self.cache=self.root/'cache'
        self.source=self.home/'registry/src/index/itoa-1.0.0';self.source.mkdir(parents=True)
        files={'Cargo.toml':b'[package]\nname="itoa"\nversion="1.0.0"\n','src/lib.rs':b'pub fn public() {}\n'}
        archive=self.home/'registry/cache/index/itoa-1.0.0.crate';archive.parent.mkdir(parents=True)
        with tarfile.open(archive,'w:gz') as tar:
            for name,data in files.items():
                info=tarfile.TarInfo('itoa-1.0.0/'+name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
                path=self.source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        (self.source/'.cargo-ok').write_text('{"v":1}')
        self.identifier=CACHE.SOURCE+'#itoa@1.0.0';self.workspace='path+file:///app#silo-ui@1.0.0'
        self.metadata=self.root/'metadata.json';self.metadata.write_text(json.dumps({'workspace_members':[self.workspace],'packages':[
            {'id':self.identifier,'name':'itoa','version':'1.0.0','source':CACHE.SOURCE,'manifest_path':str(self.source/'Cargo.toml'),'targets':[{'name':'itoa'},{'name':'build-script-build'}]},
            {'id':self.workspace,'name':'silo-ui','version':'1.0.0','source':None,'manifest_path':'/app/Cargo.toml','targets':[{'name':'silo-ui'}]}],
            'resolve':{'nodes':[{'id':self.identifier,'dependencies':[],'features':[]}],'root':self.workspace}}))
        self.lock=self.root/'Cargo.lock';self.lock.write_text('[[package]]\nname="itoa"\nversion="1.0.0"\nsource="'+CACHE.SOURCE+'"\nchecksum="'+hashlib.sha256(archive.read_bytes()).hexdigest()+'"\n')
        self.context=self.root/'context.json';self.context.write_text('{"rustc":"fixture","profile":"release"}')
        self.messages=self.root/'messages.jsonl';self.records=[]
        self.artifact=self.add_unit('release')
        app=self.target/'release/build/silo-ui-1234567890abcdef';app.mkdir(parents=True);(app/'output').write_bytes(CACHE.SENTINELS[0])
        self.records.append({'reason':'build-script-executed','package_id':self.workspace,'out_dir':str(app/'out')})
        self.args=argparse.Namespace(command='export',metadata=self.metadata,messages=self.messages,lockfile=self.lock,context=self.context,target='x86_64-unknown-linux-gnu',target_dir=self.target,cargo_home=self.home,cache_dir=self.cache,forbidden=[])
    def add_unit(self,profile):
        artifact=self.target/profile/'deps/libitoa-1234567890abcdef.rlib';artifact.parent.mkdir(parents=True,exist_ok=True);artifact.write_bytes(b'public artifact')
        artifact.with_name('itoa-1234567890abcdef.d').write_text('source')
        fp=self.target/profile/'.fingerprint/itoa-1234567890abcdef';fp.mkdir(parents=True);(fp/'lib-itoa').write_text('hash')
        self.records.append({'reason':'compiler-artifact','package_id':self.identifier,'target':{'name':'itoa','kind':['lib']},'filenames':[str(artifact)],'fresh':True})
        return artifact
    def export(self):
        self.messages.write_text('\n'.join(json.dumps(r) for r in self.records));return CACHE.perform(self.args)
    def restore(self):
        self.args.command='restore';return CACHE.perform(self.args)
    def test_host_and_target_outputs_preserved_without_application(self):
        self.add_unit('x86_64-unknown-linux-gnu/release');result=self.export();self.assertEqual(result['files'],6)
        shutil.rmtree(self.target);self.restore()
        self.assertTrue(self.artifact.exists());self.assertTrue((self.target/'x86_64-unknown-linux-gnu/release/deps/libitoa-1234567890abcdef.rlib').exists())
        self.assertFalse(any('silo' in p.name for p in self.target.rglob('*')))
    def test_public_build_script_output_keeps_native_library_and_excludes_app_output(self):
        folder=self.target/'x86_64-unknown-linux-gnu/release/build/itoa-abcdef1234567890';(folder/'out').mkdir(parents=True);(folder/'out/libnative.a').write_bytes(b'public C')
        fp=folder.parent.parent/'.fingerprint'/folder.name;fp.mkdir(parents=True);(fp/'run-build-script-build.json').write_text('{}')
        self.records.append({'reason':'build-script-executed','package_id':self.identifier,'out_dir':str(folder/'out')})
        self.export();shutil.rmtree(self.target);self.restore();self.assertEqual((folder/'out/libnative.a').read_bytes(),b'public C')
    def test_configuration_bytes_in_public_artifact_reject_export(self):
        self.artifact.write_bytes(CACHE.SENTINELS[0])
        with self.assertRaisesRegex(ValueError,'Forbidden'):self.export()
    def test_tampered_registry_source_cannot_be_approved(self):
        (self.source/'src/lib.rs').write_text('tampered')
        with self.assertRaisesRegex(ValueError,'differs from approved'):self.export()
    def test_tampered_registry_archive_rejected(self):
        next((self.home/'registry/cache/index').iterdir()).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'checksum'):self.export()
    def test_content_validation_precedes_every_timestamp_change(self):
        self.export();shutil.rmtree(self.target)
        marker=self.source/'.cargo-ok';new=marker.stat().st_mtime_ns+10_000_000_000;os.utime(marker,ns=(new,new))
        (self.source/'src/lib.rs').write_text('changed source')
        with self.assertRaisesRegex(ValueError,'content changed'):self.restore()
        self.assertEqual(marker.stat().st_mtime_ns,new);self.assertFalse(self.target.exists())
    def test_source_timestamps_and_executable_mode_restored_after_validation(self):
        self.artifact.chmod(0o755);original=(self.source/'.cargo-ok').stat().st_mtime_ns;self.export();shutil.rmtree(self.target)
        os.utime(self.source/'.cargo-ok',ns=(original+10_000_000_000,original+10_000_000_000))
        self.restore();self.assertEqual((self.source/'.cargo-ok').stat().st_mtime_ns,original);self.assertEqual(self.artifact.stat().st_mode&0o777,0o755)
    def test_changed_build_context_rejects_restore(self):
        self.export();shutil.rmtree(self.target);self.context.write_text('{"rustc":"different"}')
        with self.assertRaisesRegex(ValueError,'identity'):self.restore()
    def test_unlisted_cache_file_rejected(self):
        self.export();shutil.rmtree(self.target);(self.cache/'private').write_text('unlisted')
        with self.assertRaisesRegex(ValueError,'unlisted'):self.restore()
    def test_cache_symlink_rejected_before_following(self):
        self.export();shutil.rmtree(self.target);p=self.cache/'artifacts/release/deps';shutil.rmtree(p);p.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError,'symlink'):self.restore()
    def test_parent_traversal_in_manifest_rejected(self):
        self.export();shutil.rmtree(self.target);manifest=CACHE.read_json(self.cache/'manifest.json');manifest['artifacts'][0]['path']='../private';(self.cache/'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'unsafe'):self.restore()
    def test_missing_fingerprint_rejects_export(self):
        shutil.rmtree(self.target/'release/.fingerprint')
        with self.assertRaisesRegex(ValueError,'fingerprint'):self.export()
    def test_audit_is_read_only_and_allows_populated_target(self):
        self.export();self.args.command='audit'
        excluded=self.target/'release/build/silo-ui-1234567890abcdef/output'
        before={p:(p.read_bytes(),p.stat().st_mtime_ns) for p in (self.artifact,excluded)}
        CACHE.perform(self.args)
        self.assertEqual({p:(p.read_bytes(),p.stat().st_mtime_ns) for p in before},before)
    def test_long_forbidden_marker_crossing_read_boundary_is_rejected(self):
        marker=b'x'*300;self.args.forbidden=[marker]
        self.artifact.write_bytes(b'a'*(1024*1024-150)+marker+b'z')
        with self.assertRaisesRegex(ValueError,'Forbidden'):self.export()
    def test_invalid_directory_timestamp_precedes_every_timestamp_change(self):
        self.export();shutil.rmtree(self.target)
        marker=self.source/'.cargo-ok';new=marker.stat().st_mtime_ns+10_000_000_000;os.utime(marker,ns=(new,new))
        manifest=CACHE.read_json(self.cache/'manifest.json')
        next(iter(manifest['sources'].values()))['directories'][0]['mtimeNs']=10**100
        (self.cache/'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'invalid directory timestamp'):self.restore()
        self.assertEqual(marker.stat().st_mtime_ns,new);self.assertFalse(self.target.exists())
if __name__=='__main__':unittest.main()

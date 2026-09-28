#!/usr/bin/env python3
"""Focused regression tests for the pinned Selkies 2.0.0 client patch."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PATCH_PATH = ROOT / 'src-tauri/guest/patch-selkies-web-client.py'
SPEC = importlib.util.spec_from_file_location('selkies_client_patch', PATCH_PATH)
PATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCH)


class SelkiesClientPatchTests(unittest.TestCase):
    def fixture(self):
        # This is the exact minimized pair of affected fragments from pinned
        # selkies-core-BbKps5RD.js; unrelated minified code is intentionally out.
        return (PATCH.ONOPEN_OLD +
                b'&&console.info(`codec`),_o=!0;try{}catch{};' +
                PATCH.LATE_STATUS_OLD + b'try{}catch{};};' +
                PATCH.PRESENTED_OLD).strip()

    def test_fragments_move_waiting_state_before_delayed_codec_check(self):
        original = self.fixture()
        patched = PATCH.transform_source(original)
        original_open = original[:original.index(PATCH.PRESENTED_OLD)]
        patched_open = patched[:patched.index(PATCH.PRESENTED_NEW)]
        self.assertLess(patched_open.index(b'pr=`Connection established.'), patched_open.index(b'await Bi()'))
        self.assertEqual(patched.count(PATCH.LATE_STATUS_NEW), 1)
        self.assertEqual(patched.count(PATCH.LATE_STATUS_OLD), 0)

        # Exercise the exact transformed event order with a delayed codec probe:
        # an early MODE update must remain the final visible status.
        script = r'''
const fs = require('fs');
const source = fs.readFileSync(0, 'utf8');
const console = {log() {}, info() {}};
let fr = '', pr = '', modeSeen = false;
const updates = [];
const Gr = () => updates.push(pr);
const Bi = () => new Promise(resolve => setTimeout(resolve, 25));
const se = 'other';
let l = {};
eval(source.replace('l.onopen=', 'l.onopen='));
const opening = l.onopen();
setTimeout(() => { modeSeen = true; fr = 'waiting_stream'; pr = 'Waiting for stream...'; Gr(); }, 2);
opening.then(() => {
  process.stdout.write(JSON.stringify({modeSeen, fr, pr, updates}));
});
'''
        def run(candidate):
            result = subprocess.run(['node', '-e', script], input=candidate.decode(),
                                    text=True, capture_output=True, check=True, timeout=5)
            return json.loads(result.stdout)

        # The same delayed codec promise reproduces the old stale overwrite,
        # while the patched exact fragment preserves the early server MODE.
        self.assertEqual(run(original_open)['pr'], 'Connection established. Waiting for server mode...')
        fixed = run(patched_open)
        self.assertTrue(fixed['modeSeen'])
        self.assertEqual(fixed['fr'], 'waiting_stream')
        self.assertEqual(fixed['pr'], 'Waiting for stream...')

    def test_successful_presented_event_hides_status_once(self):
        patched = PATCH.transform_source(self.fixture())
        fragment = patched[patched.index(PATCH.PRESENTED_NEW):].decode()
        script = r'''
const fs = require('fs');
const handlerSource = fs.readFileSync(0, 'utf8');
globalThis.xr = false;
globalThis.hidden = false;
globalThis.hides = 0;
globalThis.fe = false;
globalThis.Yr = false;
globalThis.s = {style:{display:'block'}};
globalThis.no = () => { if (!globalThis.xr) { globalThis.xr = true; globalThis.hidden = true; globalThis.hides++; } };
const handle = new Function('t', handlerSource);
handle({type:'wireDims'});
const beforePresentation = hidden;
handle({type:'presented'});
const afterPresentation = hidden;
handle({type:'presented'});
process.stdout.write(JSON.stringify({beforePresentation, afterPresentation, hides}));
'''
        result = subprocess.run(['node', '-e', script], input=fragment,
                                text=True, capture_output=True, check=True, timeout=5)
        self.assertEqual(json.loads(result.stdout), {
            'beforePresentation': False,
            'afterPresentation': True,
            'hides': 1,
        })

    def test_patch_file_is_idempotent_and_rejects_changed_hash_without_write(self):
        original = self.fixture()
        patched = PATCH.transform_source(original)
        digest = lambda value: hashlib.sha256(value).hexdigest()
        PATCH.SOURCE_SHA256['test'] = digest(original)
        PATCH.PATCHED_SHA256['test'] = digest(patched)
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'selkies-core-test.js'
                path.write_bytes(original)
                path.chmod(0o640)
                self.assertEqual(PATCH.patch_file(path, 'test'), 'patched')
                self.assertEqual(path.read_bytes(), patched)
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                self.assertEqual(PATCH.patch_file(path, 'test'), 'already patched')
                changed = path.with_name('changed.js')
                changed.write_bytes(original + b' changed')
                before = changed.read_bytes()
                with self.assertRaisesRegex(ValueError, 'source hash'):
                    PATCH.patch_file(changed, 'test')
                self.assertEqual(changed.read_bytes(), before)
                self.assertEqual(set(os.listdir(directory)),
                                 {'selkies-core-test.js', 'changed.js'})
        finally:
            PATCH.SOURCE_SHA256.pop('test', None)
            PATCH.PATCHED_SHA256.pop('test', None)

    def test_transform_requires_both_exact_fragments(self):
        with self.assertRaisesRegex(ValueError, 'expected source fragments'):
            PATCH.transform_source(b'changed source')


if __name__ == '__main__':
    unittest.main()

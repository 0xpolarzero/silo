"""Test the build.rs command manifest check against fixtures and the real sources."""
from pathlib import Path
import runpy
import unittest

check = runpy.run_path(str(Path(__file__).with_name('check-command-manifest.py')), run_name='check_command_manifest')

BUILD = '''
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_state", "start",
            "reveal",
        ]),
    ))
}
'''

MAIN = '''
        .invoke_handler(tauri::generate_handler![
            state::read_state,
            // runtime::retired,
            runtime::start,
            reveal
        ])
'''


class CommandManifestTests(unittest.TestCase):
    def test_matching_lists_pass(self):
        self.assertEqual(check['differences'](BUILD, MAIN), [])

    def test_handler_missing_from_manifest_is_reported(self):
        build = BUILD.replace('"reveal",', '')
        self.assertEqual(check['differences'](build, MAIN), ['Registered in main.rs but missing from build.rs: reveal'])

    def test_manifest_entry_without_handler_is_reported(self):
        main = MAIN.replace('runtime::start,', '')
        self.assertEqual(check['differences'](BUILD, main), ['Declared in build.rs but not registered in main.rs: start'])

    def test_duplicates_are_reported(self):
        build = BUILD.replace('"start",', '"start", "start",')
        self.assertIn('build.rs lists commands more than once: start', check['differences'](build, MAIN))

    def test_repository_sources_match(self):
        tauri = check['TAURI']
        self.assertEqual(check['differences']((tauri / 'build.rs').read_text(), (tauri / 'src/main.rs').read_text()), [])


if __name__ == '__main__':
    unittest.main()

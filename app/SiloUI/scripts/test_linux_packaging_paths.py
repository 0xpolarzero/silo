"""Check packaging input changes select the real push and pull-request jobs."""
import fnmatch
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/linux-packaging.yml').read_text()


class LinuxPackagingPathTests(unittest.TestCase):
    def test_runtime_modules_and_locked_inputs_trigger_packaging(self):
        pending = [ROOT / 'app/SiloUI/scripts/prepare-microsandbox-runtime.mjs']
        inputs = set()
        while pending:
            source = pending.pop().resolve()
            if source in inputs:
                continue
            inputs.add(source)
            for imported in re.findall(r'\bfrom\s+[\'"](\.[^\'"]+)[\'"]', source.read_text()):
                pending.append(source.parent / imported)
        inputs.update(ROOT / name for name in ('app/SiloUI/guest-image/image-lock.json',
                                               'app/SiloUI/package.json', 'app/SiloUI/package-lock.json'))
        for event in ('push', 'pull_request'):
            block = re.search(r'(?ms)^  ' + event + r':\n(.*?)(?=^  [a-z_]+:|\Z)', WORKFLOW)[1]
            patterns = re.findall(r"(?m)^      - '([^']+)'$", block)
            self.assertTrue(patterns, event)
            self.assertFalse(any(pattern.startswith('!') for pattern in patterns),
                             'negative filters need ordered matching')
            for source in sorted(inputs):
                changed_path = source.relative_to(ROOT).as_posix()
                with self.subTest(event=event, changed_path=changed_path):
                    self.assertTrue(any(fnmatch.fnmatchcase(changed_path, pattern) for pattern in patterns),
                                    'packaging inputs must select the package installation job')


if __name__ == '__main__':
    unittest.main()

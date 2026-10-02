"""Accessibility polling fairness with a deterministic bus and clock."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/guest/silo-accessibility.py'
spec = importlib.util.spec_from_file_location('silo_accessibility', SOURCE)
accessibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accessibility)


class EndSweeps(Exception):
    pass


class AccessibilityPolling(unittest.TestCase):
    def run_worker(self, application_specs, sweeps):
        clock = {'now': 0.0, 'sweep': 0}
        touched = []

        class Application:
            def __init__(self, pid, children, duration):
                self.pid, self.childCount, self.duration = pid, children, duration

            def get_process_id(self):
                return self.pid

            def getAttributes(self):
                clock['now'] += self.duration
                touched.append((clock['sweep'], self.pid))
                return []

            def getRelationSet(self):
                return []

            def getChildAtIndex(self, _index):
                return None

        applications = [Application(*values) for values in application_specs]
        desktop = SimpleNamespace(childCount=len(applications), getChildAtIndex=applications.__getitem__)
        pyatspi = SimpleNamespace(Registry=SimpleNamespace(getDesktop=lambda _: desktop))
        repository = SimpleNamespace(Atspi=SimpleNamespace(set_timeout=lambda *_: None))

        def sleep(interval):
            clock['sweep'] += 1
            clock['now'] += interval
            if clock['sweep'] == sweeps:
                raise EndSweeps()

        with patch.dict(accessibility.sys.modules, {
                 'pyatspi': pyatspi, 'gi': SimpleNamespace(repository=repository),
                 'gi.repository': repository}), \
             patch.object(accessibility.time, 'monotonic', side_effect=lambda: clock['now']), \
             patch.object(accessibility.time, 'sleep', side_effect=sleep):
            with self.assertRaises(EndSweeps):
                accessibility.worker(2.0)
        return touched

    def test_empty_application_roots_do_not_starve_a_later_application(self):
        # Each empty root is responsive, so neither completes nor enters hung cooldown.
        # Together they consume the sweep budget before the application with content.
        roots = [(pid, 0, 0.3) for pid in range(10, 31)]
        touched = self.run_worker([*roots, (31, 1, 0.05)], sweeps=4)
        self.assertIn(31, [pid for _, pid in touched])
        self.assertEqual(sum(pid == 31 for _, pid in touched), 1)

    def test_handled_roots_are_skipped_on_later_sweeps(self):
        touched = self.run_worker([(10, 1, 0.05), (11, 1, 0.05)], sweeps=3)
        self.assertEqual(touched, [(0, 10), (0, 11)])

    def test_a_hung_root_keeps_its_cooldown_while_others_are_polled(self):
        touched = self.run_worker([(10, 0, 0.6), (11, 1, 0.05)], sweeps=3)
        self.assertEqual(sum(pid == 10 for _, pid in touched), 1)
        self.assertEqual(sum(pid == 11 for _, pid in touched), 1)


if __name__ == '__main__':
    unittest.main()

"""Exercise GNOME fixture selectors without Selenium or a desktop service."""
import ast
import json
from pathlib import Path
import re
import unittest


SOURCE = Path(__file__).with_name('linux_desktop_services.py')
VERIFY = next(node for node in ast.parse(SOURCE.read_text()).body
              if isinstance(node, ast.FunctionDef) and node.name == 'verify')
TRAY = (SOURCE.parents[1] / 'src-tauri/src/tray.rs').read_text()


def expression(name):
    statement = next(node for node in ast.walk(VERIFY) if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    return compile(ast.Expression(statement.value), str(SOURCE), 'eval')


class DesktopServiceFixtureTests(unittest.TestCase):
    def test_open_and_quit_selectors_accept_the_native_tray_menu(self):
        labels = re.findall(r'label: ("[^"]+")\.into\(\)', TRAY)
        layout = (0, {}, [(index + 1, {'label': json.loads(label)}, []) for index, label in enumerate(labels)])
        menu_nodes = next(node for node in VERIFY.body
                          if isinstance(node, ast.FunctionDef) and node.name == 'menu_nodes')
        namespace = {'layout': layout}
        exec(compile(ast.Module(body=[menu_nodes], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        namespace['open_item'] = eval(expression('open_item'), namespace)
        self.assertEqual(namespace['open_item'][1]['label'], 'Open Silo')
        self.assertEqual(eval(expression('quit_item'), namespace)[1]['label'], 'Quit Silo')

    def test_tray_title_and_health_metadata_match_each_channel(self):
        title = next(node.test for node in ast.walk(VERIFY)
                     if isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
                     and isinstance(node.test.left, ast.Call)
                     and any(isinstance(argument, ast.Constant) and argument.value == 'Title'
                             for argument in node.test.left.args))
        for identifier, name in [('org.silo.preview', 'Silo'), ('org.silo.dev', 'Silo Dev')]:
            with self.subTest(identifier=identifier):
                namespace = {'environment': {'XDG_DATA_HOME': '/synthetic/data',
                                             'SILO_LINUX_APPLICATION_ID': identifier},
                             'Path': Path,
                             'prop': lambda *args: name, 'destination': 'fixture', 'path': '/fixture'}
                namespace['identifier'] = eval(expression('identifier'), namespace)
                namespace['product_name'] = eval(expression('product_name'), namespace)
                self.assertTrue(eval(compile(ast.Expression(title), str(SOURCE), 'eval'), namespace))
                self.assertEqual(eval(expression('metadata'), namespace),
                                 Path('/synthetic/data') / identifier / 'runtime/machines.json')


if __name__ == '__main__':
    unittest.main()

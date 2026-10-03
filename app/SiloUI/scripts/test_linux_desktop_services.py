"""Exercise GNOME fixture selectors without Selenium or a desktop service."""
import ast
from pathlib import Path
import unittest

from channel_names import channel_for_identifier, channel_names


SOURCE = Path(__file__).with_name('linux_desktop_services.py')
VERIFY = next(node for node in ast.parse(SOURCE.read_text()).body
              if isinstance(node, ast.FunctionDef) and node.name == 'verify')


def expression(name):
    statement = next(node for node in ast.walk(VERIFY) if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))
    return compile(ast.Expression(statement.value), str(SOURCE), 'eval')


class DesktopServiceFixtureTests(unittest.TestCase):
    def test_open_and_quit_selectors_accept_the_native_tray_menu(self):
        menu_nodes = next(node for node in VERIFY.body
                          if isinstance(node, ast.FunctionDef) and node.name == 'menu_nodes')
        for channel in channel_names().values():
            name = channel['productName']
            layout = (0, {}, [(1, {'label': f'Open {name}'}, []),
                              (2, {'label': f'Quit {name}'}, [])])
            namespace = {'layout': layout, 'product_name': name}
            exec(compile(ast.Module(body=[menu_nodes], type_ignores=[]), str(SOURCE), 'exec'), namespace)
            self.assertEqual(eval(expression('open_item'), namespace)[0], 1)
            self.assertEqual(eval(expression('quit_item'), namespace)[0], 2)

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
                namespace['names'] = channel_names()
                namespace['channel_for_identifier'] = channel_for_identifier
                namespace['identifier'] = eval(expression('identifier'), namespace)
                namespace['product_name'] = eval(expression('product_name'), namespace)
                self.assertTrue(eval(compile(ast.Expression(title), str(SOURCE), 'eval'), namespace))
                self.assertEqual(eval(expression('metadata'), namespace),
                                 Path('/synthetic/data') / identifier / 'runtime/computers.json')


if __name__ == '__main__':
    unittest.main()

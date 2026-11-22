"""Host-service source closure and isolated installation checks."""
import ast
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
SETUP = SCRIPTS_DIR / 'orbis-host-service-setup.py'
UNIT = ROOT / 'packaging/systemd/orbis-host.service'


def script_names():
    tree = ast.parse(SETUP.read_text())
    return next(ast.literal_eval(node.value) for node in tree.body
                if isinstance(node, ast.Assign) and any(
                    isinstance(target, ast.Name) and target.id == 'SCRIPTS'
                    for target in node.targets))


def installer_only_loads(path, tree):
    """Prove that retained-origin source custody is reachable only from its CLI.

    The daemon imports admission for its broker API. Origin preparation also
    lives in that module, but uses the retained installer selection rather than
    the daemon installation. Do not require installer entrypoints in the daemon.
    """
    if path.name != 'orbis-host-recovery-admission.py':
        return set()
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}

    def owner(node):
        while node in parents:
            node = parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                return node.name
        return None

    for name, caller in (('_origin_retained_source', '_origin_main'), ('_origin_main', 'main')):
        references = [node for node in ast.walk(tree)
                      if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id == name]
        if len(references) != 1 or owner(references[0]) != caller:
            raise ValueError('Retained installer source lookup escaped its CLI boundary')
    loads = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Name) and node.func.id == 'load' and node.args
             and isinstance(node.args[0], ast.Constant)
             and node.args[0].value == 'orbis-host-service-setup.py']
    if len(loads) != 1 or owner(loads[0]) != '_origin_retained_source':
        raise ValueError('Installer entrypoint lookup escaped retained source custody')
    return set(loads)


def literal_dependencies(path):
    """Follow literal local loads and with_name references, including workers."""
    tree = ast.parse(path.read_text())
    result = set()
    cli_only = installer_only_loads(path, tree)
    for node in ast.walk(tree):
        if node in cli_only:
            continue
        if not isinstance(node, ast.Call) or not node.args:
            continue
        function = node.func
        name = function.id if isinstance(function, ast.Name) else (
            function.attr if isinstance(function, ast.Attribute) else '')
        if name not in {'load', 'load_script', 'with_name'}:
            continue
        value = node.args[0]
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            candidate = value.value
            if candidate.startswith(('orbis-', 'migration-')) and candidate.endswith(('.py', '.mjs')):
                result.add(candidate)
    return result


class HostDependencyClosure(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='host-closure-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stage = self.root / 'scripts'
        self.stage.mkdir()
        for name in script_names():
            shutil.copyfile(SCRIPTS_DIR / name, self.stage / name)
        unit_dir = self.root / 'packaging/systemd'
        unit_dir.mkdir(parents=True)
        shutil.copyfile(UNIT, unit_dir / UNIT.name)
        # Setup is the installer entrypoint, not itself an installed daemon dependency.
        shutil.copyfile(SETUP, self.stage / SETUP.name)

    def child(self, program):
        env = dict(os.environ, PYTHONPATH='', PYTHONDONTWRITEBYTECODE='1')
        return subprocess.run([sys.executable, '-I', '-B', '-c', program, str(self.stage)],
                              cwd=self.root, env=env, text=True, capture_output=True)

    def test_literal_daemon_closure_is_packaged(self):
        available = set(script_names())
        self.assertEqual(len(available), len(script_names()), 'duplicate setup entry')
        pending = ['orbis-host-service.py']
        visited = set()
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            self.assertIn(name, available, f'{name} is required by the daemon')
            path = SCRIPTS_DIR / name
            self.assertTrue(path.is_file(), name)
            if path.suffix == '.py':
                pending.extend(literal_dependencies(path) - visited)

    def test_installer_source_lookup_cannot_become_a_daemon_dependency(self):
        path = SCRIPTS_DIR / 'orbis-host-recovery-admission.py'
        tree = ast.parse(path.read_text())
        self.assertEqual(len(installer_only_loads(path, tree)), 1)
        dependencies = literal_dependencies(path)
        self.assertIn('orbis-host-credential-service.py', dependencies)
        self.assertNotIn('orbis-host-service-setup.py', dependencies)
        for expression in ("_origin_retained_source(None, 'a', 'b')", "_origin_main([])",
                           "load('orbis-host-service-setup.py', 'unexpected_daemon_loader')"):
            changed = ast.parse(path.read_text())
            changed.body.append(ast.parse('def daemon_handler():\n    ' + expression).body[0])
            with self.subTest(expression=expression), self.assertRaises(ValueError):
                installer_only_loads(path, changed)

    def test_installed_imports_and_missing_or_symlink_rejected(self):
        program = r'''
import importlib.util, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
original = importlib.util.spec_from_file_location
seen = set()
def checked(name, location, *args, **kwargs):
    path = pathlib.Path(location).resolve()
    assert path.parent == root, (name, path)
    seen.add(path.name)
    return original(name, location, *args, **kwargs)
importlib.util.spec_from_file_location = checked
def load(filename):
    spec = checked('closure_' + filename.replace('-', '_').replace('.', '_'), root / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
service = load('orbis-host-service.py')
assert service.HostService
for name in ('orbis-host-core-capture-reader.py', 'orbis-host-core-capture-service.py',
             'orbis-host-core-capture-worker.py', 'orbis-host-core-capture-lease.py',
             'orbis-host-core-capture-reservation.py', 'orbis-host-core-capture-reserved.py',
             'orbis-host-core-capture-supervisor.py', 'orbis-host-core-capture-completion.py',
             'orbis-host-core-capture-retirement.py', 'orbis-host-core-capture-namespace.py',
             'orbis-host-core-capture-abort.py', 'orbis-host-core-capture-empty-abort.py',
             'orbis-host-core-capture-unused-abort.py',
             'orbis-host-core-checkpoint.py', 'orbis-host-time-machine-core.py',
             'orbis-host-sentinel-observer.py', 'orbis-host-core-pg-profiles.py',
             'orbis-host-core-clean-target-bootstrap.py', 'orbis-host-core-clean-target-reconcile.py'):
    load(name)
setup = load('orbis-host-service-setup.py')
files, unit = setup.source_files(root)
assert len(files) == len(setup.SCRIPTS) and unit.is_file()
target = root / 'orbis-host-core-capture-lease.py'
original_data = target.read_bytes()
target.unlink()
for state in ('missing', 'symlink'):
    if state == 'symlink':
        target.symlink_to(root / 'orbis-host-core-capture-worker.py')
    try:
        setup.source_files(root)
        raise AssertionError(state + ' accepted')
    except ValueError as error:
        assert target.name in str(error)
    if target.is_symlink():
        target.unlink()
target.write_bytes(original_data)
assert 'orbis-host-core-capture-worker.py' in seen
'''
        result = self.child(program)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

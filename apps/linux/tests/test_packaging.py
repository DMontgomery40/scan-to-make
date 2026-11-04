import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('materialize', Path(__file__).parents[1] / 'scripts/materialize-resources.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ResourceTests(unittest.TestCase):
    def test_nested_workspace_dependencies_and_cli_survive_relocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, out = root/'prepared', root/'packaged'
            for name in ['services/companion/node_modules', 'services/project/node_modules', 'packages/contracts', 'node/bin', 'node/lib/npm/bin']:
                (source/name).mkdir(parents=True, exist_ok=True)
            (source/'packages/contracts/index.js').write_text('contract')
            (source/'services/project/index.js').write_text('project')
            (source/'services/project/node_modules/contracts').symlink_to('../../../packages/contracts')
            (source/'services/companion/node_modules/project').symlink_to('../../project')
            cli = source/'node/lib/npm/bin/npm-cli'
            cli.write_text('#!/bin/sh\nprintf "package-relative-ok:%s" "$1"\n')
            cli.chmod(0o755)
            (source/'node/bin/npm').symlink_to('../lib/npm/bin/npm-cli')
            module.materialize(source, out)
            moved = root/'relocated';out.rename(moved)
            self.assertEqual((moved/'services/companion/node_modules/project/node_modules/contracts/index.js').read_text(), 'contract')
            self.assertFalse(any(p.is_symlink() for p in moved.rglob('*')))
            self.assertEqual(subprocess.check_output([moved/'node/bin/npm','test']).decode(), 'package-relative-ok:test')

    def test_escaping_link_and_directory_cycle_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir()
            (source/'escape').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'escapes'):module.materialize(source,root/'out')
            (source/'escape').unlink();(source/'cycle').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'cycle'):module.materialize(source,root/'out2')

if __name__ == '__main__':unittest.main()

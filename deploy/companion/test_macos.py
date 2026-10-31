"""Linux-runnable checks of the actual launchd configuration and env-file helper."""
import importlib.util
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('configure', Path(__file__).with_name('configure-macos.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MacConfiguration(unittest.TestCase):
    def test_paths_and_private_env_survive_reinstall(self):
        with tempfile.TemporaryDirectory(prefix="stm mac's & paths ") as directory:
            root = Path(directory)
            state, app, agents = root / 'state', root / 'release one', root / 'LaunchAgents'
            app.mkdir()
            node = shutil.which('node')
            plist = module.configure(state, app, node, '/Applications/Blender.app/Contents/MacOS/Blender', agents)
            config = plistlib.loads(plist.read_bytes())
            self.assertEqual(config['ProgramArguments'][0], str(state / 'companion'))
            self.assertEqual(config['Umask'], 0o077)
            env = state / 'companion.env'
            env.write_text('MCP_TRANSPORT=stdio\nBAMBU_TOKEN="synthetic dollar $literal"\n')
            script = app / 'probe.mjs'
            script.write_text('console.log(JSON.stringify({token:process.env.BAMBU_TOKEN, python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON, cwd:process.cwd()}))')
            result = subprocess.run([state / 'companion', script], text=True, capture_output=True, check=True)
            import json
            value = json.loads(result.stdout)
            self.assertEqual(value['token'], 'synthetic dollar $literal')
            self.assertEqual(value['python'], str(app / '.venv/bin/python3'))
            self.assertEqual(value['cwd'], str(app))
            module.configure(state, app, node, '/blender', agents)
            self.assertIn('synthetic dollar', env.read_text())
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('synthetic dollar', plist.read_text())

    def test_installer_help_and_linux_guard(self):
        installer = str(Path(__file__).with_name('install-macos.sh'))
        subprocess.run(['bash', '-n', installer], check=True)
        self.assertEqual(subprocess.run(['bash', installer, '--help'], capture_output=True).returncode, 0)
        if os.uname().sysname == 'Linux':
            result = subprocess.run(['bash', installer, 'test.example.ts.net', 'user@example.com'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'requires macOS', result.stderr)


if __name__ == '__main__':
    unittest.main()

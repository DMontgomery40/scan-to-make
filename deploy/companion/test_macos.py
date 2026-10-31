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
            self.assertEqual(value['cwd'], str(app.resolve()))
            module.configure(state, app, node, '/blender', agents)
            self.assertIn('synthetic dollar', env.read_text())
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('synthetic dollar', plist.read_text())

    def test_installed_cleanup_helper_runs_tools_and_preserves_exit_status(self):
        import json
        import sys
        app = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix='cleanup launcher ') as tmp:
            state = Path(tmp) / 'state'
            module.configure(state, app, shutil.which('node'), '/unused/blender', Path(tmp) / 'agents')
            # The generated launcher normally points at the installed venv.
            # Use a disposable app layout linked to the actual tracked tools.
            release = Path(tmp) / 'release'
            release.mkdir()
            (release / 'tools').symlink_to(app / 'tools', target_is_directory=True)
            (release / 'deploy').symlink_to(app / 'deploy', target_is_directory=True)
            (release / '.venv/bin').mkdir(parents=True)
            (release / '.venv/bin/python3').symlink_to(sys.executable)
            module.configure(state, release, shutil.which('node'), '/unused/blender', Path(tmp) / 'agents')
            command = [state / 'companion', 'deploy/companion/cleanup.mjs']
            result = subprocess.run([*command, 'tools'], capture_output=True, text=True, check=True)
            self.assertIn('measure', {tool['name'] for tool in json.loads(result.stdout)})
            result = subprocess.run([*command, 'run'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)  # Python argparse, not Node's success status
            result = subprocess.run([*command, 'unknown'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)

    def test_lan_certificate_generation_is_private_and_preserved(self):
        import hashlib
        generator = str(Path(__file__).with_name('generate-lan-tls.py'))
        with tempfile.TemporaryDirectory(prefix='lan tls ') as tmp:
            directory = Path(tmp) / 'tls'
            command = ['python3', generator, str(directory), '127.0.0.1']
            subprocess.run(command, check=True, capture_output=True)
            key = directory / 'key.pem'
            before = hashlib.sha256(key.read_bytes()).hexdigest()
            certificate = subprocess.check_output(['openssl', 'x509', '-in', str(directory / 'cert.pem'), '-noout', '-text'], text=True)
            self.assertIn('CA:FALSE', certificate)
            self.assertNotIn('Certificate Sign', certificate)
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(hashlib.sha256(key.read_bytes()).hexdigest(), before)
            for host in ['0.0.0.0', '8.8.8.8', 'example.com']:
                result = subprocess.run(['python3', generator, str(directory), host], capture_output=True)
                self.assertNotEqual(result.returncode, 0)

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

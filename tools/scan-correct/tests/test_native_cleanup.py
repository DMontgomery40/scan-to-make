# SPDX-License-Identifier: GPL-3.0-or-later
"""Real repair -> HTTP model adapter -> sandboxed correction -> measured export."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tests'))
from fixtures import textured_box


@unittest.skipUnless(os.environ.get('BLENDER'), 'set BLENDER=Blender 5.0.1')
class NativeCleanupTests(unittest.TestCase):
    def test_repair_and_real_http_model_correction_export_measured_mesh(self):
        requests = []

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, self.headers.get('Authorization'), payload))
                if len(requests) == 1:
                    message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                        'id': 'scale-1', 'type': 'function', 'function': {
                            'name': 'scale_to_reference',
                            'arguments': json.dumps({'target_mm': [30, 20, 10]})}}]}
                else:
                    message = {'role': 'assistant', 'content': 'Synthetic correction complete.'}
                body = json.dumps({'choices': [{'message': message}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                mesh = textured_box(base)
                repair = subprocess.run([sys.executable, str(ROOT.parent/'scan-repair/repair.py'),
                                         'repair', str(mesh), '--units', 'mm', '--out', str(base/'repair')],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(repair.returncode, 0, repair.stdout+repair.stderr)
                repaired = base/'repair/repaired.obj'
                self.assertTrue(repaired.is_file())
                run = subprocess.run([sys.executable, str(ROOT/'correct.py'), 'run', str(repaired),
                                      '--units', 'mm', '--out', str(base/'result'), '--adapter', 'openai',
                                      '--model', 'synthetic-local-model', '--key-env', 'CLEANUP_TEST_KEY',
                                      '--base-url', f'http://127.0.0.1:{server.server_port}/v1',
                                      '--reference-mm', '30', '20', '10', '--max-steps', '2', '--max-seconds', '90'],
                                     env={**os.environ, 'CLEANUP_TEST_KEY': 'synthetic-model-credential',
                                          'NO_PROXY': '127.0.0.1,localhost,::1'},
                                     capture_output=True, text=True, timeout=120)
                self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
                report = json.loads((base/'result/report.json').read_text())
                self.assertEqual(report['status'], 'complete')
                self.assertEqual(report['runtime']['blenderVersion'], '5.0.1')
                self.assertEqual(report['toolFailures'], [])
                self.assertEqual(report['toolSteps'], 1)
                self.assertFalse(report['provesPhysicalAccuracy'])
                for actual, wanted in zip(report['final']['boxExtentsMm'], [30, 20, 10]):
                    self.assertAlmostEqual(actual, wanted, delta=.05)
                self.assertNotEqual(report['initial']['boxExtentsMm'], report['final']['boxExtentsMm'])
                for name, digest in report['outputs'].items():
                    self.assertEqual(hashlib.sha256((base/'result'/name).read_bytes()).hexdigest(), digest)
                # The host must reach the model both before and after worker execution.
                self.assertEqual(len(requests), 2)
                self.assertTrue(all(path == '/v1/chat/completions' and auth == 'Bearer synthetic-model-credential'
                                    for path, auth, _ in requests))
                results = [m for m in requests[1][2]['messages'] if m['role'] == 'tool']
                self.assertEqual(results[0]['tool_call_id'], 'scale-1')
                self.assertTrue(json.loads(results[0]['content'])['ok'])
                self.assertNotIn('synthetic-model-credential', (base/'result/tool-calls.jsonl').read_text())
                print('Native cleanup: repair + HTTP model + isolated correction; measured 30 x 20 x 10 mm; STL/OBJ hashes verified')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

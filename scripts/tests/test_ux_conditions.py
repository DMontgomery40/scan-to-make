"""The capture companion's bad-day proxy (scripts/ux_screens/conditions.mjs), against a stand-in companion: JSON stays
JSON, files are slowed, refused or never sent, as each condition says. These start only local processes."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import http.client
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROXY = REPO / 'scripts/ux_screens/conditions.mjs'
FILE = bytes(range(256)) * 8192  # 2 MiB, a stand-in scan
PICTURE = b'\x89PNG' + b'0' * 4096


class Companion(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path in ('/v1/objects', '/v1/objects/one'):
            body, kind = json.dumps({'objects': []} if self.path == '/v1/objects' else {'object': {'id': 'one'}}).encode(), 'application/json'
        elif self.path == '/v1/objects/one/scan':
            body, kind = FILE, 'model/vnd.usdz+zip'
        elif self.path == '/v1/objects/one/render.png':
            body, kind = PICTURE, 'image/png'
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


@unittest.skipUnless(shutil.which('node'), 'needs node')
class ConditionTests(unittest.TestCase):
    def setUp(self):
        self.companion = ThreadingHTTPServer(('127.0.0.1', 0), Companion)
        threading.Thread(target=self.companion.serve_forever, daemon=True).start()
        self.proxies = []

    def tearDown(self):
        for proxy in self.proxies:
            proxy.terminate(); proxy.wait(10)
            proxy.stdout.close()
        self.companion.shutdown(); self.companion.server_close()

    def proxy(self, condition, *extra):
        process = subprocess.Popen(['node', str(PROXY), '--target', f'http://127.0.0.1:{self.companion.server_port}',
                                    '--condition', condition, *extra], stdout=subprocess.PIPE, text=True)
        self.proxies.append(process)
        return json.loads(process.stdout.readline())['port']

    def get(self, port, path, timeout=30):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        started = time.time()
        try:
            connection.request('GET', path)
            reply = connection.getresponse()
            return reply.status, reply.getheader('content-type'), reply.read(), time.time() - started
        finally:
            connection.close()

    def test_none_passes_everything_through(self):
        port = self.proxy('none')
        status, _, body, seconds = self.get(port, '/v1/objects/one/scan')
        self.assertEqual((status, body), (200, FILE))
        self.assertLess(seconds, 2)

    def test_slow_delays_every_reply_and_trickles_files(self):
        port = self.proxy('slow', '--delay-ms', '300', '--rate', '1000000')
        status, _, body, seconds = self.get(port, '/v1/objects')
        self.assertEqual(status, 200)
        self.assertGreaterEqual(seconds, 0.3, 'JSON waits too')
        status, _, body, seconds = self.get(port, '/v1/objects/one/scan')
        self.assertEqual((status, body), (200, FILE), 'the file arrives whole')
        self.assertGreaterEqual(seconds, 2.0, f'2 MiB at 1 MB/s takes about 2 s, took {seconds:.2f}')

    def test_refusing_refuses_files_and_answers_json(self):
        port = self.proxy('refusing')
        self.assertEqual(self.get(port, '/v1/objects/one')[0], 200)
        status, kind, body, _ = self.get(port, '/v1/objects/one/scan')
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)['error']['code'], 'too-large')
        self.assertEqual(self.get(port, '/v1/objects/one/render.png')[0], 404)

    def test_away_answers_the_list_once_then_nothing(self):
        port = self.proxy('away')
        self.assertEqual(self.get(port, '/v1/objects/one')[0], 200, 'before the list, it still answers')
        self.assertEqual(self.get(port, '/v1/objects')[0], 200)
        with self.assertRaises((ConnectionError, http.client.HTTPException, OSError)):
            self.get(port, '/v1/objects/one', timeout=5)

    def test_an_unknown_condition_is_refused(self):
        run = subprocess.run(['node', str(PROXY), '--target', 'http://127.0.0.1:1', '--condition', 'sunny'],
                             capture_output=True, text=True, timeout=30)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('Unknown condition sunny', run.stderr)

    def test_the_tool_and_the_proxy_name_the_same_conditions(self):
        sys.path.insert(0, str(REPO / 'scripts'))
        import ux_screens
        names = re.findall(r'^\s+(\w+): \'', PROXY.read_text().split('export const CONDITIONS = {')[1].split('};')[0], re.M)
        self.assertEqual(names, list(ux_screens.CONDITIONS))


if __name__ == '__main__':
    unittest.main()

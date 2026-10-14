"""Host tests of the actual iOS adapter methods with only the RN bridge stubbed.
Run on macOS: python3 scripts/native-storage-tests/test.py
"""
import concurrent.futures
import pathlib
import sqlite3
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='saved-project-tests-') as directory:
    binary = str(pathlib.Path(directory) / 'runner')
    db = str(pathlib.Path(directory) / 'projects.sqlite3')
    subprocess.run(['xcrun', 'clang++', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-lsqlite3', '-I', str(root), str(root / 'runner.mm'), '-o', binary], check=True)
    def run(*args):
        return subprocess.run([binary, db, *args], capture_output=True, check=True).stdout.decode()
    original = '{"text":" café 🧰 ", "revision":0}'
    assert run('cas', 'one', 'ABSENT', original) == 'true\n'
    assert run('read', 'one') == original  # A separate native process.
    assert run('cas', 'one', original.replace(' ', ''), 'wrong') == 'false\n'
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda i: run('cas', 'one', original, f'winner-{i}'), range(8)))
    assert results.count('true\n') == 1
    winner = run('read', 'one')
    assert winner.startswith('winner-')
    assert run('cas', 'empty', 'ABSENT', '') == 'true\n'
    assert run('cas', 'empty', '', 'replaced') == 'true\n'
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TRIGGER fail_save BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'failure'); END")
    failed = subprocess.run([binary, db, 'cas', 'one', winner, 'lost'], capture_output=True)
    assert failed.returncode == 3
    assert run('read', 'one') == winner
    print('PASS: exact UTF-8 bytes, separate-process read, eight competing writers/one winner, empty bytes, failed transaction leaves bytes unchanged')

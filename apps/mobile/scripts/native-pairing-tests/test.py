"""macOS production-native seam checks; Keychain double, not secure-store proof."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='pairing-native-tests-') as directory:
    binary = str(Path(directory) / 'runner')
    subprocess.run(['xcrun', 'clang++', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-framework', 'Security', '-I', str(root.parent / 'native-storage-tests'), str(root / 'runner.mm'), '-o', binary], check=True)
    subprocess.run([binary], check=True)

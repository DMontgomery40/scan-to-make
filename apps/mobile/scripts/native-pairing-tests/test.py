"""macOS production-native seam checks; Keychain double, not secure-store proof."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='pairing-native-tests-') as directory:
    binary = str(Path(directory) / 'runner')
    # A throwaway self-signed certificate for the pin checks.
    key, pem, der = (str(Path(directory) / n) for n in ('key.pem', 'cert.pem', 'cert.der'))
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', pem, '-days', '1', '-subj', '/CN=192.168.1.20'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['openssl', 'x509', '-in', pem, '-outform', 'der', '-out', der], check=True)
    hashing = str(root.parent.parent / 'modules/local-project-storage/ios/ContentHash.mm')
    subprocess.run(['xcrun', 'clang++', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-framework', 'Security', '-I', str(root.parent / 'native-storage-tests'), str(root / 'runner.mm'), hashing, '-o', binary], check=True)
    subprocess.run([binary, der], check=True)

"""macOS production-native seam checks; Keychain double, not secure-store proof."""
from pathlib import Path
import hashlib
import subprocess
import tempfile
root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='pairing-native-tests-') as directory:
    binary = str(Path(directory) / 'runner')
    # A throwaway self-signed certificate for the pin checks.
    key, pem, der = (str(Path(directory) / n) for n in ('key.pem', 'cert.pem', 'cert.der'))
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', pem, '-days', '1', '-subj', '/CN=192.168.1.20'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['openssl', 'x509', '-in', pem, '-outform', 'der', '-out', der], check=True)
    # An EC P-256 certificate too, and each key's SubjectPublicKeyInfo SHA-256 as OpenSSL computes it.
    ec_key, ec_pem, ec_der = (str(Path(directory) / n) for n in ('ec-key.pem', 'ec-cert.pem', 'ec-cert.der'))
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', ec_key, '-out', ec_pem, '-days', '1', '-subj', '/CN=192.168.1.20'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['openssl', 'x509', '-in', ec_pem, '-outform', 'der', '-out', ec_der], check=True)
    def spki_sha256(certificate):
        key = subprocess.run(['openssl', 'x509', '-in', certificate, '-pubkey', '-noout'], check=True, capture_output=True).stdout
        spki = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'der'], input=key, check=True, capture_output=True).stdout
        return hashlib.sha256(spki).hexdigest()
    hashing = str(root.parent.parent / 'modules/local-project-storage/ios/ContentHash.mm')
    subprocess.run(['xcrun', 'clang++', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-framework', 'Security', '-framework', 'Network', '-I', str(root.parent / 'native-storage-tests'), str(root / 'runner.mm'), hashing, '-o', binary], check=True)
    # The nearby pairing test vector both the TypeScript contract and this native code must reproduce.
    vector = str(root.parent.parent.parent.parent / 'packages/contracts/fixtures/nearby-pairing-v1.json')
    subprocess.run([binary, der, spki_sha256(pem), ec_der, spki_sha256(ec_pem), vector], check=True)

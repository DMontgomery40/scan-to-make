#!/usr/bin/env python3
"""Create a private, persistent certificate for one explicitly selected LAN IP."""
import ipaddress
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def generate(directory, address):
    ip = ipaddress.IPv4Address(address)
    networks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8']
    if not any(ip in ipaddress.ip_network(net) for net in networks):
        raise ValueError('Select a private LAN IPv4 address')
    directory = Path(directory)
    if not directory.is_absolute():
        raise ValueError('Absolute private certificate directory required')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o777 != 0o700:
        raise ValueError('Certificate directory must be private')
    key, cert = directory / 'key.pem', directory / 'cert.pem'
    if key.exists() or cert.exists():
        if not key.is_file() or not cert.is_file() or key.is_symlink() or cert.is_symlink():
            raise ValueError('Incomplete certificate; inspect it before retrying')
        if key.stat().st_mode & 0o777 != 0o600:
            raise ValueError('Certificate key must be private')
        return  # init-lan verifies SAN, expiry and fingerprint; never rotate silently.
    with tempfile.TemporaryDirectory(prefix='.tls-', dir=directory) as tmp:
        tmp = Path(tmp)
        config = tmp / 'openssl.cnf'
        config.write_text(f'''[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN={ip}
[ext]
subjectAltName=IP:{ip}
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
''')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-days', '365', '-config', str(config), '-keyout', str(tmp / 'key.pem'),
                        '-out', str(tmp / 'cert.pem')], check=True, capture_output=True)
        for name in ['key.pem', 'cert.pem']:
            source = tmp / name
            source.chmod(0o600)
            # Exclusive publication preserves an existing install if another won the race.
            os.link(source, directory / name)


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 3:
        raise SystemExit('Usage: generate-lan-tls.py <absolute-private-directory> <LAN-IP>')
    generate(sys.argv[1], sys.argv[2])

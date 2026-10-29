import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function transferTlsFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orbis-transfer-tls-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  try {
    run(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'root.key',
      '-out',
      'root.pem',
      '-days',
      '2',
      '-subj',
      '/CN=Disposable transfer test root',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    );
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=source.example.test');
    writeFileSync(
      join(directory, 'leaf.ext'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:source.example.test,IP:127.0.0.1\n',
      { mode: 0o600 },
    );
    const leaf = (days: string, output: string) =>
      run(
        'x509',
        '-req',
        '-in',
        'leaf.csr',
        '-CA',
        'root.pem',
        '-CAkey',
        'root.key',
        '-CAcreateserial',
        '-out',
        output,
        '-days',
        days,
        '-extfile',
        'leaf.ext',
      );
    leaf('2', 'leaf.pem');
    leaf('0', 'expired.pem');
    run(
      'req',
      '-x509',
      '-new',
      '-key',
      'leaf.key',
      '-out',
      'self.pem',
      '-days',
      '2',
      '-subj',
      '/CN=source.example.test',
      '-addext',
      'subjectAltName=DNS:source.example.test',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    );
    const read = (name: string) => readFileSync(join(directory, name), 'utf8');
    return {
      root: read('root.pem'),
      leaf: read('leaf.pem'),
      expired: read('expired.pem'),
      self: read('self.pem'),
      key: read('leaf.key'),
      remove: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

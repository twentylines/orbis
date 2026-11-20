import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Use explicit validity dates: x509 -days 0 is rejected by newer OpenSSL. */
export function createExpiredTlsLeaf(directory: string) {
  writeFileSync(join(directory, 'expired-index.txt'), '', { mode: 0o600 });
  writeFileSync(join(directory, 'expired-serial.txt'), '1000\n', { mode: 0o600 });
  writeFileSync(
    join(directory, 'expired-ca.cnf'),
    '[ca]\ndefault_ca=fixture\n[fixture]\ndatabase=expired-index.txt\nserial=expired-serial.txt\nnew_certs_dir=.\ncertificate=root.pem\nprivate_key=root.key\ndefault_md=sha256\ndefault_days=2\npolicy=subject\nunique_subject=no\nx509_extensions=leaf\n[subject]\ncommonName=supplied\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:source.example.test,IP:127.0.0.1\n',
    { mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'ca',
      '-batch',
      '-config',
      'expired-ca.cnf',
      '-in',
      'leaf.csr',
      '-out',
      'expired.pem',
      '-notext',
      '-startdate',
      '20000101000000Z',
      '-enddate',
      '20000102000000Z',
    ],
    { cwd: directory, stdio: 'ignore' },
  );
}

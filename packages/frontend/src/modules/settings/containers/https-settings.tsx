import { SecureAccessSetup } from '../components/secure-access/secure-access';

export function HttpsSettings() {
  return (
    <div className="card-body settings-https" id="setting-https-setup">
      <SecureAccessSetup />
    </div>
  );
}

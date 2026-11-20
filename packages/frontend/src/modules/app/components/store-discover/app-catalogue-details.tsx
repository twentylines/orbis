import { Markdown } from '@/components/markdown/markdown';
import { catalogueGallery, type CatalogueCompatibility } from '../../helpers/catalogue-compatibility';
import './app-catalogue-details.css';

export function AppCatalogueDetails({ info }: { info: CatalogueCompatibility & { name: string } }) {
  const gallery = catalogueGallery(info);
  const unsupported = info.compatibility?.supported === false;
  if (info.catalog_format !== 'umbrel' && !unsupported && !gallery.length && !info.release_notes) return null;
  return (
    <div className="app-catalogue-details">
      {unsupported ? (
        <section className="app-catalogue-compatibility" aria-label="App compatibility">
          <h3>Not supported on Orbis yet</h3>
          <p>This app can be explored here, but it cannot be installed with this configuration.</p>
          {info.compatibility?.reasons.length ? (
            <ul>
              {info.compatibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : info.catalog_format === 'umbrel' ? (
        <p className="app-catalogue-origin">From the Umbrel app catalogue · adapted for Orbis</p>
      ) : null}
      {gallery.length ? (
        <section className="app-catalogue-gallery" aria-label={`${info.name} screenshots`}>
          <h3>A closer look</h3>
          <div className="app-catalogue-gallery-grid">
            {gallery.map((url, index) => (
              <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`Open ${info.name} screenshot ${index + 1}`}>
                <img src={url} alt={`${info.name} screenshot ${index + 1}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              </a>
            ))}
          </div>
        </section>
      ) : null}
      {info.release_notes ? (
        <details className="app-catalogue-release-notes">
          <summary>What’s new</summary>
          <Markdown content={info.release_notes} className="markdown" />
        </details>
      ) : null}
    </div>
  );
}

import { AppLogo } from '@/components/app-logo/app-logo';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import type { CustomLink } from '@/types/app.types';
import { useId } from 'react';
import './guest-link-tile.css';

type GuestLinkTileProps = {
  link: CustomLink;
};

export function GuestLinkTile({ link }: GuestLinkTileProps) {
  const id = useId();
  const handleClick = () => {
    window.open(link.url, '_blank', 'noreferrer');
  };

  return (
    <button
      onClick={handleClick}
      type="button"
      aria-labelledby={`${id}-title`}
      aria-describedby={link.description ? `${id}-description` : undefined}
      className="col-sm-6 col-lg-4 app-link p-2 pt-0 pb-0 mb-0 guest-link-tile-button"
      data-testid={`guest-link-tile-${link.title}`}
    >
      <div className="card card-sm card-link">
        <div className="card-body guest-link-tile-body">
          <AppLogo url={link.iconUrl || ''} size={60} />
          <div className="guest-link-tile-copy">
            <span id={`${id}-title`} className="fw-bolder">
              <WrapWords text={link.title} />
            </span>
            {link.description ? (
              <span id={`${id}-description`} className="text-muted">
                <WrapWords text={link.description} />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  );
}

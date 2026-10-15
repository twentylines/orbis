import { Button } from '@/components/ui/Button';
import { IconInbox } from '@tabler/icons-react';
import type React from 'react';
import './empty-page.css';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

interface IProps {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  redirectPath?: string;
  extraContent?: React.ReactNode;
}

export const EmptyPage: React.FC<IProps> = ({ title, subtitle, redirectPath, actionLabel, extraContent }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="card empty">
      <span className="empty-page-glyph" aria-hidden="true">
        <IconInbox size={38} stroke={1.5} />
      </span>
      <p className="empty-title">{t(title)}</p>
      {subtitle && <p className="empty-subtitle text-muted">{t(subtitle)}</p>}
      {extraContent && <div className="mt-3">{extraContent}</div>}
      <div className="empty-action">
        {redirectPath && actionLabel && (
          <Button data-testid="empty-page-action" onClick={() => navigate(redirectPath)} intent="primary">
            {t(actionLabel)}
          </Button>
        )}
      </div>
    </div>
  );
};

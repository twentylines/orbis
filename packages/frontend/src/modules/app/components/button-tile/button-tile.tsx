import clsx from 'clsx';
import './button-tile.css';

interface ButtonTileProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  className?: string;
  action: () => void;
}

export const ButtonTile = ({ title, subtitle, icon, action, className }: ButtonTileProps) => {
  return (
    <button onClick={action} className={clsx('button-tile', className)} type="button">
      <span className="button-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="button-tile-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
    </button>
  );
};

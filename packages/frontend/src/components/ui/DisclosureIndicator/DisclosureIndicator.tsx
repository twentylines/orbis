import './disclosure-indicator.css';

export function DisclosureIndicator({ size = 18 }: { size?: number }) {
  return (
    <svg className="orbis-disclosure-indicator" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 12h12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path className="orbis-disclosure-stroke" d="M12 6v12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

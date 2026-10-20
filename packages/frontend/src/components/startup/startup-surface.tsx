export function StartupSurface() {
  return (
    <div className="orbis-startup">
      <div className="orbis-startup-content">
        <img src="/icons/orbis.svg" width={64} height={64} alt="" />
        <span className="orbis-startup-name">Orbis</span>
        <output>Loading your workspace…</output>
      </div>
    </div>
  );
}

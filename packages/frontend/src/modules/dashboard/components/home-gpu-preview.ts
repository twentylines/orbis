export function previewGpu(snapshot: unknown, enabled: unknown, sampledAt: string | undefined) {
  if (typeof snapshot !== 'string' || !snapshot || enabled !== '1') return null;
  const sampled = Date.parse(sampledAt ?? '');
  return [
    {
      id: 'preview-gpu',
      simulated: true,
      label: 'Preview GPU (simulated)',
      utilizationPercent: Number.isFinite(sampled) ? 24 + Math.round(9 * Math.sin(sampled / 4000)) : 24,
    },
  ];
}

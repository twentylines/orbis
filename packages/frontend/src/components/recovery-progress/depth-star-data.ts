export type DepthStar = {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  colour: string;
  dx: string;
  dy: string;
};

export function depthStarMarks(layer: number): DepthStar[] {
  return Array.from({ length: 80 }, (_, index) => {
    const seed = index + layer * 89;
    const x = 20 + ((seed * 373 + 71) % 960);
    const y = 20 + ((seed * 537 + 193) % 960);
    const radius = index % 17 === 0 ? 1.4 : index % 5 === 0 ? 0.85 : 0.55;
    const opacity = 0.32 + ((seed * 17) % 55) / 100;
    const colour = index % 23 === 11 ? '#e3d3b5' : index % 9 === 4 ? '#c9d9e8' : '#d9e3eb';
    const distance = Math.hypot(x - 500, y - 500) || 1;
    const length = 3 + (distance / 700) * 8;
    return {
      x,
      y,
      radius,
      opacity,
      colour,
      dx: (((500 - x) / distance) * length).toFixed(2),
      dy: (((500 - y) / distance) * length).toFixed(2),
    };
  });
}

export function depthStarTexture(layer: number, trails: boolean): string {
  const marks = depthStarMarks(layer)
    .map(({ x, y, radius, opacity, colour, dx, dy }) => {
      if (!trails) return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${colour}" opacity="${opacity}"/>`;
      return `<path d="M${x},${y}l${dx},${dy}" stroke="${colour}" stroke-width="${radius * 0.65}" opacity="${opacity * 0.5}"/>`;
    })
    .join('');
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">${marks}</svg>`)}")`;
}

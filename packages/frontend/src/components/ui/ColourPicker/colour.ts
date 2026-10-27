export type HSV = { hue: number; saturation: number; brightness: number };

export function hexToHSV(hex: string): HSV {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const rgb = [red, green, blue];
  const high = Math.max(...rgb);
  const low = Math.min(...rgb);
  const delta = high - low;
  let hue = 0;
  if (delta) {
    if (high === red) hue = ((green - blue) / delta) % 6;
    else if (high === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  return { hue: (hue * 60 + 360) % 360, saturation: high ? (delta / high) * 100 : 0, brightness: high * 100 };
}

export function hsvToHex({ hue, saturation, brightness }: HSV): string {
  const chroma = (brightness / 100) * (saturation / 100);
  const sector = (((hue % 360) + 360) % 360) / 60;
  const middle = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = brightness / 100 - chroma;
  const rgb =
    sector < 1
      ? [chroma, middle, 0]
      : sector < 2
        ? [middle, chroma, 0]
        : sector < 3
          ? [0, chroma, middle]
          : sector < 4
            ? [0, middle, chroma]
            : sector < 5
              ? [middle, 0, chroma]
              : [chroma, 0, middle];
  return `#${rgb
    .map((channel) =>
      Math.round((channel + base) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

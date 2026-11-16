export function glassDisplacement(width: number, height: number, radius = 24, band = 24) {
  const scale = Math.min(1.25, 1600 / Math.max(1, width), 1000 / Math.max(1, height));
  const columns = Math.max(1, Math.ceil(width * scale));
  const rows = Math.max(1, Math.ceil(height * scale));
  const data = new Uint8ClampedArray(columns * rows * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const offset = (y * columns + x) * 4;
      data[offset] = 128;
      data[offset + 1] = 128;
      data[offset + 2] = 128;
      data[offset + 3] = 255;
      const px = (x + 0.5) / scale - width / 2;
      const py = (y + 0.5) / scale - height / 2;
      const qx = Math.abs(px) - (width / 2 - radius);
      const qy = Math.abs(py) - (height / 2 - radius);
      if (qx < -band && qy < -band) continue;
      const outsideX = Math.max(qx, 0);
      const outsideY = Math.max(qy, 0);
      const length = Math.hypot(outsideX, outsideY);
      const depth = radius - length - Math.min(Math.max(qx, qy), 0);
      if (depth <= 0 || depth >= band) continue;
      const bend = Math.sin((depth / band) * Math.PI);
      const nx = length > 0 ? (Math.sign(px) * outsideX) / length : qx > qy ? Math.sign(px) : 0;
      const ny = length > 0 ? (Math.sign(py) * outsideY) / length : qy >= qx ? Math.sign(py) : 0;
      data[offset] = 128 + nx * bend * 120;
      data[offset + 1] = 128 + ny * bend * 120;
    }
  }
  return { width: columns, height: rows, data };
}

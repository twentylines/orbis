export function appMinimizeCrossfade(startOpacity = 1) {
  return {
    window: [
      { opacity: startOpacity, offset: 0 },
      { opacity: startOpacity, offset: 0.4 },
      { opacity: 0, offset: 0.92 },
      { opacity: 0, offset: 1 },
    ],
    icon: [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.4 },
      { opacity: 1, offset: 0.85 },
      { opacity: 1, offset: 1 },
    ],
  };
}

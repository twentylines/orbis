export function scheduleThemeApplyPaint(notify: () => void, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let active = true;
  let second = 0;
  const first = request(() => {
    second = request(() => {
      if (active) notify();
    });
  });
  return () => {
    active = false;
    cancel(first);
    cancel(second);
  };
}

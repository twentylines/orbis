export function dropdownBoundaryOptions(container: HTMLElement | null) {
  return {
    portal: { container: container ?? undefined },
    content: { collisionBoundary: container ?? undefined, collisionPadding: container ? 8 : 16 },
  };
}

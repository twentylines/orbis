import { useLayoutEffect } from 'react';

export function useAppTrayLayout(desktop: boolean, count: number, element: HTMLElement | null) {
  useLayoutEffect(() => {
    const dock = element?.closest<HTMLElement>('.desktop-dock') ?? document.querySelector<HTMLElement>('.desktop-dock');
    if (!desktop || !element || !dock || !count) {
      if (dock) delete dock.dataset.minimizedCompact;
      return;
    }
    const primary = dock.querySelector<HTMLElement>('.desktop-dock-main');
    if (!primary) return;
    dock.dataset.minimizedCompact = String(count > 3);
    const measure = () => {
      const item = element.querySelector<HTMLElement>('.app-tray-item');
      const list = element.querySelector<HTMLElement>('.app-tray-list');
      if (!item || !list) return;
      const spacing = (target: Element, ...properties: string[]) => {
        const style = getComputedStyle(target);
        return properties.reduce((total, property) => total + (Number.parseFloat(style.getPropertyValue(property)) || 0), 0);
      };
      const inset = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--desktop-inset')) || 24;
      const gap = spacing(list, 'column-gap');
      const padding =
        2 * (Number.parseFloat(getComputedStyle(element).getPropertyValue('--app-tray-inset')) || 7) +
        2 +
        spacing(list, 'padding-left', 'padding-right');
      const links = [...primary.querySelectorAll<HTMLElement>('.desktop-dock-item')];
      const iconWidth = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--orbis-dock-icon-width')) || 52;
      const contractedWidth =
        links.length * iconWidth +
        spacing(primary, 'column-gap') * (links.length - 1) +
        spacing(primary, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width');
      const wrapper = element.closest('.desktop-dock-companion');
      const companions = [...dock.children].filter(
        (child) => child !== wrapper && child.matches('.desktop-dock-companion') && getComputedStyle(child).display !== 'none',
      );
      const companionWidth = companions.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
      const navigation = (count > 3 ? contractedWidth : primary.offsetWidth) + companionWidth + spacing(dock, 'column-gap') * (1 + companions.length);
      const available =
        document.documentElement.clientWidth -
        inset * 2 -
        navigation -
        spacing(dock, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width') -
        padding -
        spacing(element, 'margin-left');
      const slots = Math.max(1, Math.floor((available + gap) / (item.offsetWidth + gap)));
      const width = `${Math.min(slots, count) * (item.offsetWidth + gap) - gap + padding}px`;
      if (element.style.width !== width) element.style.width = width;
      if (element.style.maxWidth !== width) element.style.maxWidth = width;
    };
    let frame = 0;
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    for (const child of dock.children) observer.observe(child);
    const changes = new MutationObserver(() => {
      for (const child of dock.children) observer.observe(child);
      schedule();
    });
    changes.observe(dock, { childList: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, [desktop, count, element]);
}

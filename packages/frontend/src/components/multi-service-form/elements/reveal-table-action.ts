import type { FocusEvent } from 'react';

export const revealTableAction = (event: FocusEvent<HTMLButtonElement>) => {
  const button = event.currentTarget;
  const scroller = button.closest<HTMLElement>('.table-responsive');
  if (!scroller) return;

  const frame = scroller.getBoundingClientRect();
  const target = button.getBoundingClientRect();
  const scrollStyle = getComputedStyle(scroller);
  const buttonStyle = getComputedStyle(button);
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const left = frame.left + scroller.clientLeft + pixels(scrollStyle.scrollPaddingLeft) + pixels(buttonStyle.scrollMarginLeft);
  const right =
    frame.left + scroller.clientLeft + scroller.clientWidth - pixels(scrollStyle.scrollPaddingRight) - pixels(buttonStyle.scrollMarginRight);
  if (target.left < left) scroller.scrollLeft += target.left - left;
  else if (target.right > right) scroller.scrollLeft += target.right - right;
};

import { useCallback, useEffect, useRef } from 'react';

type Props = {
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetching: boolean;
};

export const useInfiniteScroll = ({ fetchNextPage, hasNextPage, isFetching }: Props) => {
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const lastNode = useRef<HTMLDivElement | null>(null);
  const lastElementRef = useCallback(
    (node: HTMLDivElement | null) => {
      lastNode.current = node;
      if (observer.current) observer.current.disconnect();
      if (!node || isFetching || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
      let root: HTMLElement | null = node.parentElement;
      while (root && !/^(auto|scroll|overlay)$/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
      // Body overflow can propagate to the viewport; it is not a nested scroll pane.
      if (root === document.body || root === document.documentElement) root = null;
      const ahead = Math.round(Math.max(640, Math.min(1600, (root?.clientHeight || window.innerHeight) * 2)));
      let requested = false;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (!requested && entries[0]?.isIntersecting) {
            requested = true;
            fetchNextPage();
          }
        },
        { root, rootMargin: `0px 0px ${ahead}px 0px` },
      );
      observer.current.observe(node);
    },
    [fetchNextPage, hasNextPage, isFetching],
  );

  useEffect(() => {
    let frame = 0;
    const resized = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (lastNode.current) lastElementRef(lastNode.current);
      });
    };
    window.addEventListener('resize', resized);
    return () => {
      window.removeEventListener('resize', resized);
      cancelAnimationFrame(frame);
    };
  }, [lastElementRef]);

  useEffect(() => {
    return () => {
      if (observer.current) observer.current.disconnect();
    };
  }, []);

  return { lastElementRef };
};

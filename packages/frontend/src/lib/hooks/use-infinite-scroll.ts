import { useCallback, useEffect, useRef } from 'react';

type Props = {
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetching: boolean;
};

export const useInfiniteScroll = ({ fetchNextPage, hasNextPage, isFetching }: Props) => {
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const lastElementRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observer.current) observer.current.disconnect();
      if (!node || isFetching || !hasNextPage) return;
      let root: HTMLElement | null = node.parentElement;
      while (root && !/^(auto|scroll|overlay)$/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
      // Body overflow can propagate to the viewport; it is not a nested scroll pane.
      if (root === document.body || root === document.documentElement) root = null;
      const ahead = Math.round(Math.max(320, Math.min(800, (root?.clientHeight || window.innerHeight) * 0.75)));
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
    return () => {
      if (observer.current) observer.current.disconnect();
    };
  }, []);

  return { lastElementRef };
};

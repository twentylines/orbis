import type { SSE, Topic } from '@runtipi/common/schemas';
import { useEffect, useRef, useState } from 'react';

type Props<T> = {
  topic: T;
  onEvent: (event: Extract<SSE, { topic: T }>['data']) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
  params?: URLSearchParams;
};

export const useSSE = <T extends Topic>({ topic, onEvent, onError, onOpen, params }: Props<T>) => {
  const handlers = useRef({ onEvent, onError, onOpen });
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const query = params?.toString() ?? '';
  useEffect(() => {
    handlers.current = { onEvent, onError, onOpen };
  }, [onEvent, onError, onOpen]);

  useEffect(() => {
    let disposed = false;
    let stream: EventSource | null = null;
    let timer: number | undefined;
    let retries = 0;
    const clearRetry = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const closeStream = () => {
      if (!stream) return;
      stream.onmessage = null;
      stream.onopen = null;
      stream.onerror = null;
      stream.close();
      stream = null;
    };
    const connect = () => {
      if (disposed || (stream && stream.readyState !== EventSource.CLOSED)) return;
      clearRetry();
      const url = new URL(`/api/sse/${topic}`, window.location.origin);
      url.search = query;
      const source = new EventSource(url);
      stream = source;
      setStatus(retries ? 'reconnecting' : 'connecting');
      source.onmessage = (event) => {
        if (disposed || source !== stream) return;
        try {
          handlers.current.onEvent(JSON.parse(event.data));
        } catch (error) {
          console.error('Failed to handle SSE message:', error);
        }
      };
      source.onopen = () => {
        if (disposed || source !== stream) return;
        retries = 0;
        setStatus('connected');
        handlers.current.onOpen?.();
      };
      source.onerror = (error) => {
        if (disposed || source !== stream) return;
        handlers.current.onError?.(error);
        closeStream();
        clearRetry();
        if (retries < 5) {
          retries += 1;
          setStatus('reconnecting');
          timer = window.setTimeout(connect, 2 ** retries * 1000);
        } else {
          setStatus('disconnected');
        }
      };
    };
    const reconnect = () => {
      if (!stream || stream.readyState === EventSource.CLOSED) {
        retries = 0;
        connect();
      }
    };
    connect();
    window.addEventListener('focus', reconnect);
    window.addEventListener('online', reconnect);
    return () => {
      disposed = true;
      clearRetry();
      closeStream();
      window.removeEventListener('focus', reconnect);
      window.removeEventListener('online', reconnect);
    };
  }, [topic, query]);
  return status;
};

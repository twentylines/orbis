import type { Request, Response } from 'express';
import { Transform } from 'node:stream';
import {
  EMPTY,
  Observable,
  type Subscription,
  catchError,
  defer,
  filter,
  interval,
  startWith,
  take,
  takeUntil,
  takeWhile,
  throwError,
  timer,
} from 'rxjs';

/** Close idle streams within one second; recheck before every delivered event. */
export function sessionStream<T>(source: Observable<T>, isCurrent: () => boolean): Observable<T> {
  const current = () => {
    try {
      return isCurrent();
    } catch {
      return false;
    }
  };
  return defer(() => {
    if (!current()) return EMPTY;
    const revoked = interval(1000).pipe(
      startWith(0),
      filter(() => !current()),
    );
    return source.pipe(
      takeWhile(current),
      takeUntil(revoked),
      catchError((error) => (current() ? throwError(() => error) : EMPTY)),
    );
  });
}

type ResponseFraming = { stream?: Transform; clear: () => void };
const responseFraming = new WeakMap<Response, ResponseFraming>();

/** Guards run before Nest pipes SSE, even when interceptors defer the handler. */
export function prepareStreamResponse(response: Response): ResponseFraming {
  const existing = responseFraming.get(response);
  if (response.destroyed || response.writableEnded || response.writableFinished) {
    existing?.clear();
    return { clear: () => undefined };
  }
  if (existing) return existing;
  const capture = (stream: unknown) => {
    if (stream instanceof Transform) state.stream = stream;
  };
  const clear = () => {
    response.off('pipe', capture);
    response.off('close', clear);
    response.off('finish', clear);
    if (responseFraming.get(response) === state) responseFraming.delete(response);
  };
  const state: ResponseFraming = { clear };
  responseFraming.set(response, state);
  response.once('pipe', capture);
  response.once('close', clear);
  response.once('finish', clear);
  return state;
}

/** Nest can buffer events after the source. Recheck at the transport write. */
export function requestStream<T>(
  source: Observable<T>,
  request: Request,
  response?: Response,
  authorize?: () => boolean,
  shutdown: Observable<void> = EMPTY,
): Observable<T> {
  const framing = response ? prepareStreamResponse(response) : undefined;
  return defer(() => {
    const current = () => {
      try {
        return !request.destroyed && !response?.destroyed && (!authorize || authorize());
      } catch {
        return false;
      }
    };
    const accepting = () => !response?.writableEnded && current();
    if (!accepting()) {
      framing?.clear();
      return EMPTY;
    }
    const disconnected = new Observable<void>((subscriber) => {
      const close = () => subscriber.next();
      request.once?.('close', close);
      response?.once('close', close);
      response?.once('finish', close);
      if (!accepting()) close();
      return () => {
        request.off?.('close', close);
        response?.off('close', close);
        response?.off('finish', close);
      };
    });
    if (response) {
      const write = response.write;
      const end = response.end;
      let endArguments: unknown[] | undefined;
      let cancelled = false;
      let stopping: Subscription | undefined;
      let shutdownGrace: Subscription | undefined;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        framing?.stream?.destroy();
        response.destroy();
        request.destroy?.();
      };
      const guarded = ((...args: unknown[]) => {
        if (!accepting()) {
          cancel();
          return false;
        }
        return Reflect.apply(write, response, args);
      }) as Response['write'];
      const finish = ((...args: unknown[]) => {
        if (!current()) {
          cancel();
          return response;
        }
        // Nest's writeMessage callback can precede readable drain. End the
        // framing stream first; its pipe ends the response after the last frame.
        const stream = framing?.stream;
        if (stream && !stream.readableEnded) {
          endArguments ??= args;
          if (!stream.writableEnded) stream.end();
          return response;
        }
        return Reflect.apply(end, response, endArguments ?? args);
      }) as Response['end'];
      // Keep revocation active while valid EOF frames wait on a slow client.
      const watch = authorize ? interval(1000).subscribe(() => !current() && cancel()) : undefined;
      const restore = () => {
        if (response.write === guarded) response.write = write;
        if (response.end === finish) response.end = end;
        watch?.unsubscribe();
        stopping?.unsubscribe();
        shutdownGrace?.unsubscribe();
        if (framing?.stream && !framing.stream.readableEnded) framing.stream.destroy();
        framing?.clear();
        response.off('close', restore);
        response.off('finish', restore);
      };
      response.write = guarded;
      response.end = finish;
      response.once('close', restore);
      response.once('finish', restore);
      // Let responsive clients finish queued frames, but bound shutdown even
      // after upstream EOF and on CLI streams without a session watchdog.
      stopping = shutdown.pipe(take(1)).subscribe(() => {
        shutdownGrace = timer(250).subscribe(cancel);
      });
    }
    const active = source.pipe(takeUntil(shutdown));
    return (authorize ? sessionStream(active, accepting) : active).pipe(takeUntil(disconnected));
  });
}

import { Injectable } from '@nestjs/common';
import { validateThemeFrameworkCatalogue, type ThemeFrameworkCatalogue } from '@runtipi/common/schemas/theme-framework-catalogue';

export const THEME_CATALOGUE_URL = 'https://raw.githubusercontent.com/twentylines/orbis-themes/main/catalogue.json';
export const THEME_AUTHORING_URL = 'https://github.com/twentylines/orbis-themes/blob/main/docs/README.md';
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
const RETRY_COOLDOWN_MS = 30_000;
type Cached = { value: ThemeFrameworkCatalogue; etag?: string; checkedAt: number };
const cancelBody = (body: ReadableStream<Uint8Array> | null) => {
  if (body) void body.cancel().catch(() => undefined);
};

@Injectable()
export class ThemeFrameworkCatalogueService {
  private cached?: Cached;
  private pending?: Promise<void>;
  private retryAfter = 0;

  private async refresh() {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('Catalogue request timed out'));
      }, TIMEOUT_MS);
    });
    try {
      await Promise.race([this.fetchCatalogue(abort.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }

  private async fetchCatalogue(signal: AbortSignal) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cached?.etag) headers['If-None-Match'] = this.cached.etag;
    const response = await fetch(THEME_CATALOGUE_URL, { headers, signal, redirect: 'error' });
    if (signal.aborted) cancelBody(response.body);
    signal.throwIfAborted();
    if (response.status === 304) {
      if (!this.cached?.etag) {
        cancelBody(response.body);
        throw new Error('Unexpected catalogue response');
      }
      this.cached.checkedAt = Date.now();
      return;
    }
    if (!response.ok || !response.body) {
      cancelBody(response.body);
      throw new Error('Catalogue unavailable');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
      cancelBody(response.body);
      throw new Error('Catalogue too large');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let complete = false;
    try {
      while (true) {
        const result = await reader.read();
        signal.throwIfAborted();
        if (result.done) {
          complete = true;
          break;
        }
        bytes += result.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('Catalogue too large');
        chunks.push(result.value);
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const value = validateThemeFrameworkCatalogue(JSON.parse(text));
    signal.throwIfAborted();
    const candidate = response.headers.get('etag');
    const etag = candidate && candidate.length <= 256 && /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(candidate) ? candidate : undefined;
    this.cached = { value, etag, checkedAt: Date.now() };
  }

  async read() {
    const now = Date.now();
    const expired = !this.cached || now < this.cached.checkedAt || now - this.cached.checkedAt >= TTL_MS;
    const canRetry = now >= this.retryAfter || now < this.retryAfter - RETRY_COOLDOWN_MS;
    if (expired && canRetry) {
      if (!this.pending) {
        this.pending = this.refresh()
          .then(() => {
            this.retryAfter = 0;
          })
          .catch((error) => {
            this.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
            throw error;
          })
          .finally(() => {
            this.pending = undefined;
          });
      }
      try {
        await this.pending;
      } catch {
        /* Keep the last validated catalogue, if any. */
      }
    }
    const checkedNow = Date.now();
    return {
      status: this.cached ? (checkedNow < this.cached.checkedAt || checkedNow - this.cached.checkedAt >= TTL_MS ? 'stale' : 'ready') : 'unavailable',
      catalogue: this.cached ? structuredClone(this.cached.value) : null,
      checkedAt: this.cached ? new Date(this.cached.checkedAt).toISOString() : null,
      runtimeAvailable: false,
      authoringUrl: THEME_AUTHORING_URL,
    } as const;
  }
}

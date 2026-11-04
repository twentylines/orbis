import http from 'node:http';
import { controllerCaptureSocketIdentity } from '@/modules/host-updates/host-controller-config';
import { parseCoreUpdateProgress, type CoreUpdateProgress } from './core-update-progress';

export type RootRestorationState = 'idle' | 'restoring' | 'recovery' | 'checking';

export type RootCoreState = 'idle' | 'updating' | 'downgrading' | 'recovery' | 'checking';

async function readState(socket: string | undefined, route: string, allowed: readonly string[]): Promise<string | null> {
  if (!socket) return null;
  try {
    const identity = await controllerCaptureSocketIdentity(socket);
    let unsupported = false;
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const request = http.request({ socketPath: socket, path: route, method: 'GET', signal: AbortSignal.timeout(2000) }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          if (response.statusCode === 404) {
            unsupported = true;
            resolve(Buffer.alloc(0));
          } else reject(new Error('unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024) response.destroy(new Error('invalid'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('aborted')));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', reject);
      request.end();
    });
    if ((await controllerCaptureSocketIdentity(socket)) !== identity) return 'checking';
    if (unsupported) return null;
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !('state' in data)) return 'checking';
    const { state } = data as { state: unknown };
    return typeof state === 'string' && allowed.includes(state) ? state : 'checking';
  } catch {
    return 'checking';
  }
}

export async function readRootRestorationState(socket = process.env.ORBIS_HOST_SOCKET): Promise<RootRestorationState | null> {
  return readState(socket, '/v1/retained-restore/maintenance', ['idle', 'restoring', 'recovery', 'checking']) as Promise<RootRestorationState | null>;
}

export async function readRootCoreState(socket = process.env.ORBIS_HOST_SOCKET): Promise<RootCoreState | null> {
  return readState(socket, '/v1/core-operation/maintenance', [
    'idle',
    'updating',
    'downgrading',
    'recovery',
    'checking',
  ]) as Promise<RootCoreState | null>;
}

export async function readRootCoreProgress(socket = process.env.ORBIS_HOST_SOCKET): Promise<CoreUpdateProgress | null> {
  if (!socket) return null;
  try {
    const identity = await controllerCaptureSocketIdentity(socket);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const request = http.get({ socketPath: socket, path: '/v1/core-operation/progress', signal: AbortSignal.timeout(2000) }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) response.destroy(new Error('invalid'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('aborted')));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', reject);
    });
    if ((await controllerCaptureSocketIdentity(socket)) !== identity) return null;
    return parseCoreUpdateProgress(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

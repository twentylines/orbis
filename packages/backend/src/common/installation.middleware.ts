import type { NextFunction, Request, Response } from 'express';
import { INSTALLATION_MESSAGE, installationHeld } from './installation-mode';

export const installationMiddleware = (request: Request, response: Response, next: NextFunction) => {
  if (!installationHeld()) return next();
  const pathname = request.originalUrl.split('?')[0] ?? '';
  const isStatus = ['/api/health', '/api/health/', '/api/installation/status', '/api/installation/status/'].includes(pathname);
  if (isStatus && (request.method === 'GET' || request.method === 'HEAD')) return next();
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Retry-After', '2');
  return response.status(503).json({ statusCode: 503, code: 'ORBIS_INSTALLATION_IN_PROGRESS', message: INSTALLATION_MESSAGE });
};

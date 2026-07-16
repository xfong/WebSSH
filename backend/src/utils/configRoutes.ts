import { Express, Request, Response } from 'express';
import os from 'os';

export function registerConfigRoutes(app: Express): void {
  /**
   * GET /api/v1/config
   * Returns server-side configuration needed by the frontend before login.
   */
  app.get('/api/v1/config', (_req: Request, res: Response) => {
    res.json({
      hostname: process.env.SERVER_HOSTNAME || os.hostname(),
      themes: ['light', 'dark', 'system'],
    });
  });
}

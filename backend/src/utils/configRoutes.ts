import { Express, Request, Response } from 'express';
import os from 'os';
import { verifyToken } from '../middleware/auth';
import { getNode } from '../session/store';

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

  /**
   * GET /api/v1/xpra-url/:nodeId
   * Returns the nginx proxy URL for the Xpra HTML5 server for a given node.
   * The URL is of the form /xpra-proxy/PORT/ and can be used as an iframe src.
   *
   * Requires a valid JWT (Bearer token in Authorization header).
   * Only the node owner or an admin may access this endpoint.
   */
  app.get('/api/v1/xpra-url/:nodeId', async (req: Request, res: Response) => {
    // Verify JWT
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    let auth: { username: string; role: string };
    try {
      auth = verifyToken(token) as { username: string; role: string };
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { nodeId } = req.params;
    const node = await getNode(nodeId);

    if (!node || node.type !== 'xpra') {
      return res.status(404).json({ error: 'Xpra session not found' });
    }

    if (auth.role !== 'admin' && node.username !== auth.username) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!node.xpraPort) {
      return res.status(503).json({ error: 'No Xpra port assigned to this session' });
    }

    // Return the nginx proxy URL — the browser loads this as an iframe src
    const proxyUrl = `/xpra-proxy/${node.xpraPort}/`;
    return res.json({ url: proxyUrl, port: node.xpraPort });
  });
}

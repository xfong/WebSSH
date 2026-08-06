import { Express, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateViaPam } from './pam';
import { authenticateAdmin } from './admin';
import { JWT_SECRET } from '../utils/secrets';

const JWT_EXPIRES_IN = '12h';

export function registerAuthRoutes(app: Express): void {
  /**
   * POST /api/v1/auth/login
   * Body: { username: string, password: string }
   * Returns: { token: string, role: 'user' | 'admin', username: string }
   *
   * Authentication order:
   *   1. Admin check (local bcrypt hash — always checked first, no PAM)
   *   2. PAM helper (host PAM stack via Unix socket → SSSD → local accounts)
   */
  app.post('/api/v1/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // ── Step 1: Admin check (local account, independent of PAM) ──────────────
    // If the username matches the configured admin username, the result of the
    // local bcrypt check is FINAL — do not fall through to PAM.
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;
    if (username === ADMIN_USERNAME) {
      const isAdmin = await authenticateAdmin(username, password);
      if (isAdmin) {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        return res.json({ token, role: 'admin', username });
      }
      // Username is the admin account but password is wrong — reject immediately.
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // ── Step 2: PAM authentication (sole path for regular users) ─────────────
    const pamResult = await authenticateViaPam(username, password);

    if (pamResult.ok) {
      const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token, role: 'user', username });
    }

    if (pamResult.unavailable) {
      // PAM helper is not running or unreachable — return a clear error.
      console.error(
        `PAM helper unavailable (${pamResult.error}). Cannot authenticate user "${username}".`,
      );
      return res.status(503).json({
        error: 'Authentication service unavailable. Please contact the system administrator.',
      });
    }

    // PAM helper returned a definitive authentication failure.
    return res.status(401).json({ error: 'Invalid credentials' });
  });

  /**
   * POST /api/v1/auth/logout
   * Invalidates the session token (client-side; server-side blacklist via Redis optional).
   */
  app.post('/api/v1/auth/logout', (_req: Request, res: Response) => {
    // Token invalidation is handled client-side by discarding the JWT.
    // For stricter invalidation, add the JTI to a Redis blacklist here.
    res.status(200).json({ message: 'Logged out' });
  });
}

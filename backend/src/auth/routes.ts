import { Express, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateUser } from './ldap';
import { authenticateAdmin } from './admin';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '12h';

export function registerAuthRoutes(app: Express): void {
  /**
   * POST /api/v1/auth/login
   * Body: { username: string, password: string }
   * Returns: { token: string, role: 'user' | 'admin', username: string }
   */
  app.post('/api/v1/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Check admin first (local account, no LDAP)
    const isAdmin = await authenticateAdmin(username, password);
    if (isAdmin) {
      const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token, role: 'admin', username });
    }

    // LDAP authentication for regular users
    const ldapOk = await authenticateUser(username, password);
    if (ldapOk) {
      const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token, role: 'user', username });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  });

  /**
   * POST /api/v1/auth/logout
   * Invalidates the session token (client-side; server-side blacklist via Redis optional)
   */
  app.post('/api/v1/auth/logout', (_req: Request, res: Response) => {
    // Token invalidation is handled client-side by discarding the JWT.
    // For stricter invalidation, add the JTI to a Redis blacklist here.
    res.status(200).json({ message: 'Logged out' });
  });
}

import { Express, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateViaPam } from './pam';
import { authenticateUser as authenticateViaLdap } from './ldap';
import { authenticateAdmin } from './admin';
import { JWT_SECRET } from '../utils/secrets';

const JWT_EXPIRES_IN = '12h';

/**
 * Returns true if at least one LDAP server is configured.
 * Evaluated lazily so that changes to the environment variable are picked up
 * without restarting the process (though in practice the container must be
 * restarted to pick up .env changes).
 */
function ldapConfigured(): boolean {
  return (process.env.LDAP_HOST || '')
    .split(',')
    .map(h => h.trim().replace(/^ldaps?:\/\//i, ''))
    .filter(h => h.length > 0)
    .length > 0;
}

export function registerAuthRoutes(app: Express): void {
  /**
   * POST /api/v1/auth/login
   * Body: { username: string, password: string }
   * Returns: { token: string, role: 'user' | 'admin', username: string }
   *
   * Authentication order:
   *   1. Admin check (local bcrypt hash — always checked first, no PAM/LDAP)
   *   2. PAM helper (host PAM stack via Unix socket → SSSD → LDAP/local accounts)
   *   3. Direct LDAP fallback — ONLY if PAM is unavailable AND LDAP_HOST is set.
   *      If PAM is unavailable and LDAP_HOST is empty, return 503 immediately.
   */
  app.post('/api/v1/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // ── Step 1: Admin check (local account, independent of PAM/LDAP) ──────────
    // If the username matches the configured admin username, the result of the
    // local bcrypt check is FINAL — do not fall through to PAM or LDAP.
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

    // ── Step 2: PAM authentication (primary path for regular users) ───────────
    const pamResult = await authenticateViaPam(username, password);

    if (pamResult.ok) {
      // PAM authenticated the user successfully.
      const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token, role: 'user', username });
    }

    if (!pamResult.unavailable) {
      // PAM helper is running but returned a definitive auth failure.
      // Do not fall through to LDAP — the credentials are wrong.
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // PAM helper is unavailable (not running, socket missing, timeout, etc.).
    // Fall back to direct LDAP only if LDAP servers are configured.
    if (!ldapConfigured()) {
      // No LDAP fallback available — surface a clear error rather than silently
      // returning 401 (which would imply wrong credentials rather than a config issue).
      console.error(
        `PAM helper unavailable (${pamResult.error}) and LDAP_HOST is not configured. ` +
        `Cannot authenticate user "${username}". ` +
        `Ensure the webssh-pam-helper service is running on the host: ` +
        `systemctl status webssh-pam-helper`,
      );
      return res.status(503).json({
        error:
          'Authentication service unavailable. ' +
          'The PAM helper is not running and no LDAP fallback is configured. ' +
          'Please contact the system administrator.',
      });
    }

    // ── Step 3: Direct LDAP fallback ──────────────────────────────────────────
    console.warn(
      `PAM helper unavailable (${pamResult.error}). Falling back to direct LDAP for user "${username}".`,
    );
    const ldapOk = await authenticateViaLdap(username, password);
    if (ldapOk) {
      const token = jwt.sign({ username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ token, role: 'user', username });
    }

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

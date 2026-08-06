import bcrypt from 'bcrypt';
import { getAdminHash } from '../utils/secrets';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;

/**
 * Authenticate the local administrator account.
 * The password hash is read from /run/secrets/admin_hash (Docker secrets file)
 * via the shared secrets utility, with a fallback to the ADMIN_PASSWORD_HASH
 * environment variable for local development.
 */
export async function authenticateAdmin(username: string, password: string): Promise<boolean> {
  if (username !== ADMIN_USERNAME) return false;
  const hash = getAdminHash();
  if (!hash || hash === 'CHANGE_ME') return false;
  return bcrypt.compare(password, hash);
}

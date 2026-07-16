import bcrypt from 'bcrypt';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH!;

/**
 * Authenticate the local administrator account.
 * Credentials are stored in environment variables (set by setup.sh).
 */
export async function authenticateAdmin(username: string, password: string): Promise<boolean> {
  if (username !== ADMIN_USERNAME) return false;
  if (!ADMIN_PASSWORD_HASH || ADMIN_PASSWORD_HASH === 'CHANGE_ME') return false;
  return bcrypt.compare(password, ADMIN_PASSWORD_HASH);
}

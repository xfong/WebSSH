import fs from 'fs';

/**
 * Read a secret value from a Docker secrets file, falling back to an
 * environment variable if the file is not present (e.g. local development).
 *
 * Secrets are stored as plain files mounted at /run/secrets/ by Docker Compose.
 * This avoids Docker Compose $$ interpolation corrupting values that contain
 * $ characters (such as bcrypt hashes and hex JWT secrets).
 */
function readSecret(filePath: string, envFallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return process.env[envFallback] || '';
  }
}

/**
 * The JWT signing/verification secret.
 * Read once at module load time from /run/secrets/jwt_secret.
 */
export const JWT_SECRET: string = readSecret('/run/secrets/jwt_secret', 'JWT_SECRET');

/**
 * The bcrypt hash of the admin password.
 * Read on every authentication call (not cached) so that an admin password
 * change takes effect without restarting the container.
 */
export function getAdminHash(): string {
  return readSecret('/run/secrets/admin_hash', 'ADMIN_PASSWORD_HASH');
}

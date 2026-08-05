import net from 'net';

/**
 * PAM Authentication via Unix Socket
 *
 * Communicates with the webssh-pam-helper service running on the Docker host.
 * The helper is exposed to the container via a bind-mounted Unix socket.
 *
 * Protocol: newline-delimited JSON
 *   Request:  { "username": "...", "password": "..." }
 *   Response: { "ok": true }  or  { "ok": false, "error": "..." }
 */

const PAM_SOCKET_PATH = process.env.PAM_SOCKET_PATH || '/run/webssh/pam.sock';
const PAM_TIMEOUT_MS  = parseInt(process.env.PAM_TIMEOUT_MS || '5000', 10);

/**
 * Authenticate a user via the PAM helper Unix socket.
 *
 * Returns:
 *   { ok: true }                           — authentication succeeded
 *   { ok: false, error: string }           — authentication failed (wrong credentials)
 *   { ok: false, error: string, unavailable: true } — helper unreachable; caller should fall back to LDAP
 */
export async function authenticateViaPam(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string; unavailable?: boolean }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(PAM_SOCKET_PATH);
    let settled = false;
    let responseBuffer = '';

    const settle = (result: { ok: boolean; error?: string; unavailable?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    // Timeout — treat as unavailable so the caller falls back to LDAP.
    const timer = setTimeout(() => {
      settle({ ok: false, error: 'PAM helper timed out', unavailable: true });
    }, PAM_TIMEOUT_MS);

    socket.on('connect', () => {
      const request = JSON.stringify({ username, password }) + '\n';
      socket.write(request);
    });

    socket.on('data', (chunk) => {
      responseBuffer += chunk.toString();
      const newlineIdx = responseBuffer.indexOf('\n');
      if (newlineIdx === -1) return; // wait for complete response

      const line = responseBuffer.slice(0, newlineIdx).trim();
      try {
        const response = JSON.parse(line) as { ok: boolean; error?: string };
        settle(response);
      } catch {
        settle({ ok: false, error: 'Invalid response from PAM helper', unavailable: true });
      }
    });

    socket.on('error', (err) => {
      // ENOENT or ECONNREFUSED means the helper is not running — fall back to LDAP.
      const isUnavailable = ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(
        (err as NodeJS.ErrnoException).code || '',
      );
      settle({
        ok: false,
        error: err.message,
        unavailable: isUnavailable,
      });
    });

    socket.on('close', () => {
      if (!settled) {
        settle({ ok: false, error: 'PAM helper closed connection unexpectedly', unavailable: true });
      }
    });
  });
}

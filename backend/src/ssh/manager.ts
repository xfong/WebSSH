import { Client as SSHClient, ClientChannel } from 'ssh2';

const SSH_HOST = process.env.SSH_HOST || 'host.docker.internal';
const SSH_PORT = parseInt(process.env.SSH_PORT || '22', 10);

export interface SSHSession {
  client: SSHClient;
  stream: ClientChannel;
}

/**
 * Opens an SSH connection and allocates a PTY for the given user.
 * The user's plaintext password is used for authentication (passed from the
 * login flow and held in memory only for the duration of the connection setup).
 *
 * @param env  Optional environment variables to set in the remote shell
 *             (e.g. { DISPLAY: ':10' } for X11 forwarding via Xpra).
 *
 * NOTE: For production hardening, consider SSH key-based auth or an SSH agent.
 */
export function openSSHSession(
  username: string,
  password: string,
  cols: number,
  rows: number,
  env?: Record<string, string>,
): Promise<SSHSession> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();

    client.on('ready', () => {
      // ssh2's three-argument overload: shell(PseudoTtyOptions, ShellOptions, callback)
      // env is passed via ShellOptions; term/cols/rows via PseudoTtyOptions.
      client.shell(
        { term: 'xterm-256color', cols, rows },
        { env: env as NodeJS.ProcessEnv | undefined },
        (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }
          resolve({ client, stream });
        },
      );
    });

    client.on('error', (err) => reject(err));

    client.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username,
      password,
    });
  });
}

export function resizeSSHSession(stream: ClientChannel, cols: number, rows: number): void {
  (stream as unknown as { setWindow: (rows: number, cols: number, height: number, width: number) => void })
    .setWindow(rows, cols, 0, 0);
}

export function closeSSHSession(session: SSHSession): void {
  try {
    session.stream.end();
    session.client.end();
  } catch {
    // ignore errors on close
  }
}

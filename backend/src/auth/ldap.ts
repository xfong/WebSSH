import ldap from 'ldapjs';
import fs from 'fs';

// LDAP_HOST may be a comma-separated list of hostnames/IPs.
// Servers are tried in order; the first one that successfully authenticates
// the user wins. Plain LDAP (unencrypted) is never used — only LDAPS and
// STARTTLS are attempted.
// Strip any ldap:// or ldaps:// protocol prefix that may have been included
// in the LDAP_HOST config value (e.g. "ldaps://host.example.com").
// The code constructs the correct URL scheme internally.
const LDAP_HOSTS: string[] = (process.env.LDAP_HOST || '')
  .split(',')
  .map(h => h.trim().replace(/^ldaps?:\/\//i, ''))
  .filter(h => h.length > 0);

const LDAP_USER_DN_TEMPLATE = process.env.LDAP_USER_DN_TEMPLATE!;
const LDAP_CA_CERT_PATH = process.env.LDAP_CA_CERT_PATH;

// Load the CA certificate once at startup (if provided).
let caCert: Buffer | undefined;
if (LDAP_CA_CERT_PATH && fs.existsSync(LDAP_CA_CERT_PATH)) {
  const content = fs.readFileSync(LDAP_CA_CERT_PATH);
  if (content.length > 0) caCert = content;
}

/** Build an ldapjs client for a given host using LDAPS (port 636). */
function buildLdapsClient(host: string): ldap.Client {
  const tlsOptions: Record<string, unknown> = {};
  if (caCert) tlsOptions.ca = [caCert];

  return ldap.createClient({
    url: `ldaps://${host}:636`,
    tlsOptions,
  });
}

/** Build an ldapjs client for a given host using STARTTLS (plain port 389, upgraded). */
function buildStartTlsClient(host: string): ldap.Client {
  const tlsOptions: Record<string, unknown> = {};
  if (caCert) tlsOptions.ca = [caCert];

  return ldap.createClient({
    url: `ldap://${host}:389`,
    // starttls is initiated explicitly after the client connects (see tryStartTlsBind).
  });
}

/** Attempt a bind over an already-connected LDAPS client. */
function tryLdapsBind(client: ldap.Client, dn: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    client.bind(dn, password, (err) => {
      client.destroy();
      resolve(!err);
    });
  });
}

/** Attempt a STARTTLS upgrade followed by a bind. */
function tryStartTlsBind(host: string, dn: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tlsOptions: Record<string, unknown> = {};
    if (caCert) tlsOptions.ca = [caCert];

    const client = buildStartTlsClient(host);

    client.starttls(tlsOptions, [], (tlsErr) => {
      if (tlsErr) {
        client.destroy();
        return resolve(false);
      }
      client.bind(dn, password, (bindErr) => {
        client.destroy();
        resolve(!bindErr);
      });
    });
  });
}

/** Build a plain (unencrypted) ldapjs client for a given host (port 389). */
function buildPlainClient(host: string): ldap.Client {
  return ldap.createClient({ url: `ldap://${host}:389` });
}

/**
 * Try to authenticate a user against a single LDAP server.
 * Connection attempts are made in this order:
 *   1. LDAPS       — port 636, TLS from the start
 *   2. STARTTLS    — port 389, upgraded to TLS
 *   3. Plain LDAP  — port 389, unencrypted (fallback of last resort)
 * Returns true if authentication succeeded, false otherwise.
 */
async function tryServer(host: string, dn: string, password: string): Promise<boolean> {
  // 1. Try LDAPS (port 636)
  try {
    const client = buildLdapsClient(host);
    const ok = await tryLdapsBind(client, dn, password);
    if (ok) return true;
  } catch {
    // LDAPS failed — try STARTTLS
  }

  // 2. Try STARTTLS (port 389, upgraded to TLS)
  try {
    const ok = await tryStartTlsBind(host, dn, password);
    if (ok) return true;
  } catch {
    // STARTTLS also failed — try plain LDAP
  }

  // 3. Try plain LDAP (port 389, unencrypted)
  try {
    const client = buildPlainClient(host);
    const ok = await tryLdapsBind(client, dn, password);
    if (ok) return true;
  } catch {
    // Plain LDAP also failed
  }

  return false;
}

/**
 * Authenticate a user against the configured LDAP servers.
 * Servers are tried in the order listed in LDAP_HOST.
 * The first server that successfully authenticates the user wins.
 * If all servers fail (or are unreachable), returns false.
 */
export async function authenticateUser(username: string, password: string): Promise<boolean> {
  if (LDAP_HOSTS.length === 0) {
    console.error('LDAP_HOST is not configured. Cannot authenticate user.');
    return false;
  }

  const dn = LDAP_USER_DN_TEMPLATE.replace('{username}', username);

  for (const host of LDAP_HOSTS) {
    try {
      const ok = await tryServer(host, dn, password);
      if (ok) return true;
      // This server returned a definitive "wrong credentials" — no point trying
      // other servers for a bad password. Return false immediately.
      return false;
    } catch {
      // This server is unreachable or threw an unexpected error.
      // Log and continue to the next server.
      console.warn(`LDAP: server ${host} unreachable, trying next server.`);
    }
  }

  // All servers exhausted without a successful authentication.
  return false;
}

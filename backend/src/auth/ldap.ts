import ldap from 'ldapjs';
import fs from 'fs';

const LDAP_HOST = process.env.LDAP_HOST!;
const LDAP_USER_DN_TEMPLATE = process.env.LDAP_USER_DN_TEMPLATE!;
const LDAP_CA_CERT_PATH = process.env.LDAP_CA_CERT_PATH;

function buildClient(useTLS: boolean): ldap.Client {
  const protocol = useTLS ? 'ldaps' : 'ldap';
  const port = useTLS ? 636 : 389;
  const url = `${protocol}://${LDAP_HOST}:${port}`;

  const tlsOptions: Record<string, unknown> = {};
  if (useTLS && LDAP_CA_CERT_PATH && fs.existsSync(LDAP_CA_CERT_PATH)) {
    const caContent = fs.readFileSync(LDAP_CA_CERT_PATH);
    if (caContent.length > 0) {
      tlsOptions.ca = [caContent];
    }
  }

  return ldap.createClient({ url, tlsOptions });
}

function tryBind(client: ldap.Client, dn: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    client.bind(dn, password, (err) => {
      client.destroy();
      resolve(!err);
    });
  });
}

/**
 * Authenticate a user against the LDAP server.
 * Tries LDAPS first; falls back to plain LDAP on failure.
 */
export async function authenticateUser(username: string, password: string): Promise<boolean> {
  const dn = LDAP_USER_DN_TEMPLATE.replace('{username}', username);

  // Attempt LDAPS
  try {
    const clientTLS = buildClient(true);
    const result = await tryBind(clientTLS, dn, password);
    if (result) return true;
  } catch {
    // LDAPS failed — fall through to plain LDAP
  }

  // Fallback: plain LDAP
  try {
    const clientPlain = buildClient(false);
    return await tryBind(clientPlain, dn, password);
  } catch {
    return false;
  }
}

/**
 * IMAP configuration.
 *
 * Reads credentials from environment variables so secrets never end up in
 * the git-tracked source. Copy .env.example to .env and fill in your
 * values -- .env is gitignored and stays local to your machine.
 *
 * Supports multiple IMAP logins: the primary account uses the unsuffixed
 * IMAP_USER/IMAP_PASSWORD/... variables, and additional accounts use a
 * numeric suffix (IMAP_USER_2/IMAP_PASSWORD_2/..., IMAP_USER_3/..., and so
 * on). Each account's email address doubles as its "source" label, which is
 * what gets stored alongside every cached email so imports from different
 * mailboxes never mix together.
 */

// Node 20.12+/21.7+ (we're on Node 22) can load a .env file natively.
// Load it relative to this file, not the current working directory --
// MCP clients (e.g. Claude Desktop) launch this script with their own
// cwd, so a relative './env' lookup would silently miss the file.
const path = require('node:path');
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  // No .env file found -- fall back to whatever is already in the
  // environment (e.g. variables set by the shell or MCP client config).
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

// Reads one IMAP account from env vars with the given suffix ('' for the
// primary account, '_2', '_3', ... for additional ones). Returns null if no
// IMAP_USER<suffix> is set, unless requireUser forces it.
function readAccount(suffix, { requireUser = false } = {}) {
  const userKey = `IMAP_USER${suffix}`;
  const user = process.env[userKey];
  if (!user) {
    if (requireUser) required(userKey);
    return null;
  }
  return {
    source: user,
    user,
    password: required(`IMAP_PASSWORD${suffix}`),
    host: process.env[`IMAP_HOST${suffix}`] || 'imap.example.com',
    port: process.env[`IMAP_PORT${suffix}`] ? Number(process.env[`IMAP_PORT${suffix}`]) : 993,
    tls: process.env[`IMAP_TLS${suffix}`] !== 'false',
  };
}

const accounts = [readAccount('', { requireUser: true })];
for (let i = 2; ; i++) {
  const account = readAccount(`_${i}`);
  if (!account) break;
  accounts.push(account);
}

const sourceDuplicates = accounts
  .map((a) => a.source)
  .filter((source, i, all) => all.indexOf(source) !== i);
if (sourceDuplicates.length > 0) {
  throw new Error(`Duplicate IMAP account(s) configured for: ${[...new Set(sourceDuplicates)].join(', ')}`);
}

// Resolves an account by its source (email address). Omit to get the
// primary (first configured) account.
function getAccount(source) {
  if (!source) return accounts[0];
  const account = accounts.find((a) => a.source === source);
  if (!account) {
    throw new Error(
      `Unknown IMAP account: ${source}. Configured accounts: ${accounts.map((a) => a.source).join(', ')}`
    );
  }
  return account;
}

module.exports = { accounts, getAccount };

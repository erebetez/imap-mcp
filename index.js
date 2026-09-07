#!/usr/bin/env node

/**
 * IMAP MCP Server
 *
 * Model Context Protocol server that gives any MCP client
 * email fetching capabilities via IMAP.
 *
 * Communicates over stdio using JSON-RPC 2.0 or streamable HTTP

 * SETUP: yarn add imap mailparser
 */

const http = require('http');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const SERVER_INFO = {
  name: 'imap',
  version: '0.1.0',
};

const IMAP_CONFIG = require('./imap_config');
const cache = require('./imap_cache');

const ACCOUNT_SOURCES = IMAP_CONFIG.accounts.map((a) => a.source);
const PRIMARY_SOURCE = ACCOUNT_SOURCES[0];
const ACCOUNTS_LIST = ACCOUNT_SOURCES.join(', ');

const TOOLS = [
  {
    name: 'imap_list_unseen',
    description: `List all unseen emails in the INBOX. Returns a numbered list with unique UID, FROM, DATE, SUBJECT and ACCOUNT for each email. Configured accounts: ${ACCOUNTS_LIST}. Omit 'account' to check all of them at once.`,
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: `Which account to check (by email address). Omit to check all configured accounts: ${ACCOUNTS_LIST}` },
      },
    },
  },
  {
    name: 'imap_fetch_email',
    description: `Fetch the full content of a specific email by its unique UID returned from imap_list_unseen or imap_list_cached.`,
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'The unique UID of the email to fetch' },
        account: { type: 'string', description: `Which account the email belongs to (by email address). Defaults to the primary account (${PRIMARY_SOURCE}). Configured accounts: ${ACCOUNTS_LIST}` },
      },
      required: ['uid'],
    },
  },
  {
    name: 'imap_mark_seen',
    description: 'Mark one or more emails as seen by their UIDs. Pass UIDs as a JSON array, e.g. [46] for a single email or [42, 46] for multiple.',
    inputSchema: {
      type: 'object',
      properties: {
        uids: {
          type: 'array',
          items: { type: 'number' },
          description: 'A JSON array of one or more unique UIDs, e.g. [46] or [42, 46]',
        },
        account: { type: 'string', description: `Which account the emails belong to (by email address). Defaults to the primary account (${PRIMARY_SOURCE}). Configured accounts: ${ACCOUNTS_LIST}` },
      },
      required: ['uids'],
    },
  },
  {
    name: 'imap_import_recent',
    description: `Import emails from a mailbox that are not older than N days, caching them locally in SQLite (tagged with which account they came from) so repeated calls do not re-fetch or re-parse emails already imported. Returns how many were found, newly imported, and already cached, plus the list of newly imported emails. Configured accounts: ${ACCOUNTS_LIST}. Omit 'account' to import from all of them.`,
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Only import emails received within this many days' },
        mailbox: { type: 'string', description: 'Mailbox to import from (default: INBOX)' },
        account: { type: 'string', description: `Which account to import from (by email address). Omit to import from all configured accounts: ${ACCOUNTS_LIST}` },
      },
      required: ['days'],
    },
  },
  {
    name: 'imap_list_cached',
    description: 'List previously imported emails from the local SQLite cache without contacting the IMAP server. Use after imap_import_recent to browse or filter emails cheaply. Each result includes which account it was imported from.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Only list cached emails not older than this many days (optional, default: all cached)' },
        mailbox: { type: 'string', description: 'Mailbox to list from (default: INBOX)' },
        limit: { type: 'number', description: 'Maximum number of emails to return (default: 200)' },
        account: { type: 'string', description: `Only list emails imported from this account (by email address). Omit to list emails from all accounts. Configured accounts: ${ACCOUNTS_LIST}` },
      },
    },
  },
  {
    name: 'imap_write_draft',
    description: 'Save a draft email in the Entwurf folder. Pass recipient, subject, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Plain-text body of the draft' },
        inReplyTo: { type: 'string', description: 'Message-ID to reply to (optional)' },
        references: { type: 'string', description: 'References header (optional)' },
        account: { type: 'string', description: `Which account to save the draft in (by email address). Defaults to the primary account (${PRIMARY_SOURCE}). Configured accounts: ${ACCOUNTS_LIST}` },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────
function jsonrpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── IMAP helpers ────────────────────────────────────────────────────────────

// Fetches and parses a single message by UID. Used to pull messages one at a
// time (sequentially) instead of issuing one multi-UID FETCH, since some IMAP
// servers misbehave when asked to stream back many messages at once.
async function fetchOneMessage(imap, uid) {
  return new Promise((resolve, reject) => {
    const fetched = imap.fetch(uid, { bodies: '' });
    let attrs = null;

    fetched.on('message', (msg) => {
      msg.once('attributes', (a) => { attrs = a; });
      msg.on('body', (stream) => {
        simpleParser(stream, (err, parsed) => {
          if (err) return reject(err);
          resolve({ attrs, parsed });
        });
      });
    });

    fetched.once('error', (ex) => reject(ex));
  });
}

async function withImap(mailbox, account, fn) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(account);
    imap.once('error', (err) => reject(new Error(`IMAP error (${account.source}): ${err.message}`)));
    imap.once('end', () => {});
    imap.once('ready', () => {
      imap.openBox(mailbox, false, (err, box) => {
        if (err) return reject(new Error(`Failed to open ${mailbox} (${account.source}): ${err.message}`));
        fn(imap, box).then(resolve, reject);
      });
    });
    imap.connect();
  });
}

async function listUnseenEmails(account) {
  return withImap('INBOX', account, async (imap) => {
    const results = await new Promise((resolve, reject) => {
      imap.search(['UNSEEN'], (err, res) => {
        if (err) return reject(new Error(`Search failed: ${err.message}`));
        resolve(res || []);
      });
    });

    if (results.length === 0) {
      imap.end();
      return [];
    }

    const emails = [];
    for (const uid of results) {
      try {
        const { attrs, parsed } = await fetchOneMessage(imap, uid);
        const from = parsed.from;
        const fromText = Array.isArray(from) ? from[0].text : (from?.text || 'unknown');
        emails.push({ uid: attrs?.uid ?? uid, account: account.source, from: fromText, date: parsed.date, subject: parsed.subject || '(no subject)' });
      } catch (err) {
        console.error(`Fetch/parse error uid=${uid}: ${err.message}`);
      }
    }

    imap.end();
    return emails;
  });
}

// Lists unseen emails across every configured account. A single account
// failing to connect (e.g. bad credentials, unreachable server) is reported
// per-account instead of aborting the whole call.
async function listUnseenEmailsAllAccounts() {
  const emails = [];
  const errors = [];
  for (const account of IMAP_CONFIG.accounts) {
    try {
      emails.push(...(await listUnseenEmails(account)));
    } catch (err) {
      errors.push({ account: account.source, error: err.message });
    }
  }
  return { emails, errors };
}

async function fetchEmailById(uid, account) {
  return withImap('INBOX', account, (imap) => new Promise((resolve, reject) => {
    const fetched = imap.fetch(uid, { bodies: '' });

    fetched.on('message', (msg) => {
      let collectedUid = null;

      msg.once('attributes', (attrs) => {
        collectedUid = attrs.uid;
      });

      msg.on('body', (stream) => {
        simpleParser(stream, (err, parsed) => {
          imap.end();
          if (err) return reject(new Error(`Parse error: ${err.message}`));
          resolve({
            uid: collectedUid ?? uid,
            account: account.source,
            from: parsed.from?.text || 'unknown',
            subject: parsed.subject || '(no subject)',
            date: parsed.date?.toISOString() || '',
            text: parsed.text || '',
            html: parsed.html || '',
            messageId: parsed.messageId || null,
            inReplyTo: Array.isArray(parsed.inReplyTo)
              ? parsed.inReplyTo.map((m) => m.value).join(', ')
              : (parsed.inReplyTo || null),
          });
        });
      });
    });

    fetched.once('error', (ex) => {
      imap.end();
      reject(new Error(`Fetch error: ${ex.message}`));
    });
  }));
}

async function markSeen(uids, account) {
  if (!uids || !Array.isArray(uids) || uids.length === 0) {
    throw new Error("imap_mark_seen requires a non-empty 'uids' array");
  }
  return withImap('INBOX', account, (imap) => new Promise((resolve, reject) => {
    imap.addFlags(uids, ['\\Seen'], (err) => {
      imap.end();
      if (err) return reject(new Error(`Failed to mark emails as seen: ${err.message}`));
      resolve({ marked: uids.length, uids, account: account.source });
    });
  }));
}

async function appendDraft(params, account) {
  const { to, subject, body, inReplyTo, references } = params;
  const sender = account.user;

  const headers = [
    `From: ${sender}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: <${inReplyTo}>` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean).join('\r\n');

  const message = headers + '\r\n\r\n' + body;

  return withImap('INBOX', account, (imap) => new Promise((resolve, reject) => {
    imap.append(message, { mailbox: 'Entwurf' }, (err) => {
      if (err) return reject(new Error(`Failed to save draft: ${err.message}`));
      resolve({ success: true, message: 'Draft saved to Entwurf folder', account: account.source });
    });
  }));
}

async function importRecentEmailsForAccount({ days, mailbox, account }) {
  return withImap(mailbox, account, async (imap, box) => {
    const uidvalidity = box.uidvalidity;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const results = await new Promise((resolve, reject) => {
      imap.search([['SINCE', since]], (err, res) => {
        if (err) return reject(new Error(`Search failed: ${err.message}`));
        resolve(res || []);
      });
    });

    if (results.length === 0) {
      imap.end();
      return { found: 0, imported: 0, skipped: 0, emails: [] };
    }

    const cachedUids = cache.getCachedUids(account.source, mailbox, uidvalidity);
    const newUids = results.filter((uid) => !cachedUids.has(uid));

    if (newUids.length === 0) {
      imap.end();
      return { found: results.length, imported: 0, skipped: results.length, emails: [] };
    }

    const imported = [];
    for (const uid of newUids) {
      try {
        const { attrs, parsed } = await fetchOneMessage(imap, uid);
        const flags = attrs?.flags || [];
        const from = parsed.from;
        const fromText = Array.isArray(from) ? from[0].text : (from?.text || 'unknown');
        const date = parsed.date ? parsed.date.toISOString() : null;
        const record = {
          source: account.source,
          mailbox,
          uidvalidity,
          uid,
          messageId: parsed.messageId || null,
          from: fromText,
          subject: parsed.subject || '(no subject)',
          date,
          seen: flags.includes('\\Seen') ? 1 : 0,
          text: parsed.text || '',
          html: parsed.html || '',
          inReplyTo: Array.isArray(parsed.inReplyTo)
            ? parsed.inReplyTo.map((m) => m.value).join(', ')
            : (parsed.inReplyTo || null),
          importedAt: new Date().toISOString(),
        };
        cache.upsertEmail(record);
        imported.push({ uid, account: account.source, from: fromText, date, subject: record.subject });
      } catch (err) {
        console.error(`Fetch/parse error uid=${uid} account=${account.source}: ${err.message}`);
      }
    }

    imap.end();
    return {
      found: results.length,
      imported: imported.length,
      skipped: results.length - newUids.length,
      emails: imported,
    };
  });
}

// Imports recent emails either from one account (when `account` is given) or
// from every configured account. A single account failing to connect is
// reported per-account instead of aborting the whole call.
async function importRecentEmails({ days, mailbox = 'INBOX', account }) {
  if (!days || days <= 0) {
    throw new Error("imap_import_recent requires a positive 'days'");
  }

  const accounts = account ? [IMAP_CONFIG.getAccount(account)] : IMAP_CONFIG.accounts;

  const byAccount = [];
  const errors = [];
  for (const acc of accounts) {
    try {
      byAccount.push({ account: acc.source, ...(await importRecentEmailsForAccount({ days, mailbox, account: acc })) });
    } catch (err) {
      errors.push({ account: acc.source, error: err.message });
    }
  }

  return {
    found: byAccount.reduce((sum, r) => sum + r.found, 0),
    imported: byAccount.reduce((sum, r) => sum + r.imported, 0),
    skipped: byAccount.reduce((sum, r) => sum + r.skipped, 0),
    emails: byAccount.flatMap((r) => r.emails),
    byAccount,
    errors,
  };
}

function listCachedEmails({ days, mailbox = 'INBOX', limit = 200, account } = {}) {
  return cache.listCached({ mailbox, days, limit, source: account });
}

// ─── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(name, args = {}) {
  switch (name) {
    case 'imap_list_unseen': {
      const { emails, errors } = args.account
        ? { emails: await listUnseenEmails(IMAP_CONFIG.getAccount(args.account)), errors: [] }
        : await listUnseenEmailsAllAccounts();
      const numbered = emails.map((e, i) => ({ index: i + 1, uid: e.uid, account: e.account, from: e.from, date: e.date, subject: e.subject }));
      return JSON.stringify({ count: numbered.length, emails: numbered, errors }, null, 2);
    }

    case 'imap_fetch_email': {
      const uid = args.uid;
      if (uid == null) throw new Error("imap_fetch_email requires a non-empty 'uid'");
      const email = await fetchEmailById(uid, IMAP_CONFIG.getAccount(args.account));
      return JSON.stringify(email, null, 2);
    }

    case 'imap_mark_seen': {
      const result = await markSeen(args.uids, IMAP_CONFIG.getAccount(args.account));
      return JSON.stringify(result, null, 2);
    }

    case 'imap_import_recent': {
      const result = await importRecentEmails(args);
      return JSON.stringify(result, null, 2);
    }

    case 'imap_list_cached': {
      const emails = listCachedEmails(args);
      return JSON.stringify({ count: emails.length, emails }, null, 2);
    }

    case 'imap_write_draft': {
      const result = await appendDraft(args, IMAP_CONFIG.getAccount(args.account));
      return JSON.stringify(result, null, 2);
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP message handler ─────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return jsonrpc(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonrpc(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const text = await executeTool(name, args || {});
        return jsonrpc(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return jsonrpc(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }

    case 'ping':
      return jsonrpc(id, {});

    default:
      if (id) return jsonrpcError(id, -32601, `Method not found: ${method}`);
      return null;
  }
}

// ─── CLI & transport setup ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = { verbose: false };

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--verbose' || arg === '-v') options.verbose = true;
  else if (arg.startsWith('--host')) { const [, val] = arg.split('='); options.host = val ?? args[++i]; }
  else if (arg.startsWith('--port')) { const [, val] = arg.split('='); options.port = val ? Number(val) : Number(args[++i]); }
}
if (options.host && options.port == null) options.port = 3000;

function log(msg, ...vals) {
  if (!options.verbose) return;
  const prefix = `[${new Date().toISOString()}] VERBOSE: `;
  console.error(`${prefix}${msg.replace(/%s/g, () => vals.shift() ?? '')}`);
}

console.error('✅ CLI options:', options);

// ─── stdio transport ─────────────────────────────────────────────────────────

function startStdioTransport() {
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        const response = await handleMessage(msg);
        if (response) process.stdout.write(response + '\n');
      } catch (err) {
        process.stdout.write(jsonrpcError(null, -32700, `Parse error: ${err.message}`) + '\n');
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

// ─── HTTP transport ──────────────────────────────────────────────────────────

function startHttpServer(host, port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Use POST with JSON-RPC messages');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    });

    let buffer = '';
    req.on('data', (chunk) => { buffer += chunk.toString(); });
    req.on('end', async () => {
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim());
          const response = await handleMessage(msg);
          if (response) res.write(response + '\n');
        } catch (e) {
          res.write(jsonrpcError(null, -32700, `Parse error: ${e.message}`) + '\n');
        }
      }
      res.end();
    });
  });

  server.on('error', (err) => { console.error(`[FATAL] ${err.message}`); process.exit(1); });
  server.listen(port, host, () => console.error(`✅ MCP HTTP server on http://${host}:${port}`));
  process.on('SIGINT', () => process.exit(0));
}

// ─── Launch ──────────────────────────────────────────────────────────────────

if (options.host) {
  startHttpServer(options.host, Number(options.port));
} else {
  startStdioTransport();
}

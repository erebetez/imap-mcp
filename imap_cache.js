/**
 * Local SQLite cache for imported emails.
 *
 * Uses Node's built-in node:sqlite module (available since Node 22.5,
 * stable/experimental in the version this project targets) so no native
 * dependency needs to be installed or compiled.
 *
 * Emails are keyed by (source, mailbox, uidvalidity, uid) -- UIDs are only
 * guaranteed stable for a given UIDVALIDITY on a given account, which
 * changes if the mailbox is rebuilt server-side. Keying on all four means a
 * UIDVALIDITY change naturally causes a fresh import instead of silently
 * mixing up UIDs, and emails from different IMAP accounts never collide.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.IMAP_CACHE_DB || path.join(__dirname, 'imap_cache.db');

let db = null;

// Pre-existing databases (from before multi-account support) have an
// `emails` table with no `source` column. Migrate them in place, attributing
// all previously-imported emails to the primary configured account.
function migrateAddSourceColumn(database) {
  const columns = database.prepare('PRAGMA table_info(emails)').all();
  if (columns.length === 0) return; // fresh install, nothing to migrate
  if (columns.some((c) => c.name === 'source')) return; // already migrated

  const { accounts } = require('./imap_config');
  const defaultSource = accounts[0].source;

  database.exec('ALTER TABLE emails RENAME TO emails_pre_multi_account');
  database.exec(`
    CREATE TABLE emails (
      source TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      uidvalidity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      from_addr TEXT,
      subject TEXT,
      date TEXT,
      seen INTEGER,
      text TEXT,
      html TEXT,
      in_reply_to TEXT,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (source, mailbox, uidvalidity, uid)
    );
  `);
  database.prepare(`
    INSERT INTO emails
      (source, mailbox, uidvalidity, uid, message_id, from_addr, subject, date, seen, text, html, in_reply_to, imported_at)
    SELECT @defaultSource, mailbox, uidvalidity, uid, message_id, from_addr, subject, date, seen, text, html, in_reply_to, imported_at
    FROM emails_pre_multi_account
  `).run({ defaultSource });
  database.exec('DROP TABLE emails_pre_multi_account');
}

function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      source TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      uidvalidity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      from_addr TEXT,
      subject TEXT,
      date TEXT,
      seen INTEGER,
      text TEXT,
      html TEXT,
      in_reply_to TEXT,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (source, mailbox, uidvalidity, uid)
    );
  `);
  migrateAddSourceColumn(db);
  return db;
}

function getCachedUids(source, mailbox, uidvalidity) {
  const rows = getDb()
    .prepare('SELECT uid FROM emails WHERE source = ? AND mailbox = ? AND uidvalidity = ?')
    .all(source, mailbox, uidvalidity);
  return new Set(rows.map((r) => Number(r.uid)));
}

function upsertEmail(record) {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO emails
        (source, mailbox, uidvalidity, uid, message_id, from_addr, subject, date, seen, text, html, in_reply_to, imported_at)
      VALUES (@source, @mailbox, @uidvalidity, @uid, @messageId, @from, @subject, @date, @seen, @text, @html, @inReplyTo, @importedAt)
    `)
    .run(record);
}

function listCached({ mailbox = 'INBOX', days, limit = 200, source } = {}) {
  const params = { mailbox, limit };
  let query = `
    SELECT source, uid, message_id AS messageId, from_addr AS from_, subject, date, seen, in_reply_to AS inReplyTo
    FROM emails
    WHERE mailbox = @mailbox
  `;
  if (source) {
    query += ' AND source = @source';
    params.source = source;
  }
  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    query += ' AND date >= @since';
    params.since = since.toISOString();
  }
  query += ' ORDER BY date DESC LIMIT @limit';
  return getDb().prepare(query).all(params);
}

module.exports = { getDb, getCachedUids, upsertEmail, listCached, DB_PATH };

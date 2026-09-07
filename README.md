 # Simple IMAP MCP

 Model Context Protocol server that provides email fetching and drafting capabilities via IMAP.

 ## Setup

 ```bash
 git clone https://github.com/woheller69/simple-imap-mcp.git
 cd simple-imap-mcp
 npm install
 ```

 (The dependencies are plain `imap` and `mailparser` -- `npm install` and `yarn add imap mailparser` both work against the included `package.json`.)

 ## Configuration

 Credentials are read from environment variables at startup (via Node's
 built-in `process.loadEnvFile()`), not from a tracked source file, so your
 password never ends up in git.

 Copy `.env.example` to `.env` and fill in your values:

 ```bash
 cp .env.example .env
 ```

 ```
 IMAP_USER=your@email.com
 IMAP_PASSWORD=your-password
 IMAP_HOST=imap.example.com
 IMAP_PORT=993
 IMAP_TLS=true
 ```

 `.env` is listed in `.gitignore` and will never be committed. `imap_config.js`
 just reads these variables and throws a clear error at startup if
 `IMAP_USER` or `IMAP_PASSWORD` is missing.

 ### Multiple IMAP accounts

 Add as many additional accounts as you like with a numeric suffix (`_2`,
 `_3`, ...):

 ```
 IMAP_USER_2=your-second@email.com
 IMAP_PASSWORD_2=your-second-password
 IMAP_HOST_2=imap.example.com
 IMAP_PORT_2=993
 IMAP_TLS_2=true
 ```

 Each account's email address doubles as its "source" label. Tools that act
 on a single account (`imap_fetch_email`, `imap_mark_seen`, `imap_write_draft`)
 take an optional `account` argument (defaults to the primary, unsuffixed
 account) to pick which one to use. `imap_list_unseen` and
 `imap_import_recent` check every configured account when `account` is
 omitted, and `imap_list_cached` can filter by `account` to see what came
 from just one mailbox.

 ## Local email cache

 `imap_import_recent` and `imap_list_cached` use Node's built-in `node:sqlite`
 module (no extra dependency to install), so **Node 22.5+** is required.
 Imported emails are stored in `imap_cache.db` next to the source files
 (override the location with `IMAP_CACHE_DB` in `.env`), tagged with the
 account (`source`) they were imported from. The cache key is `(source,
 mailbox, uidvalidity, uid)`, so re-running `imap_import_recent` never
 re-fetches or re-parses an email it already has -- it only pulls new UIDs
 since the last import. A database created before multi-account support was
 added is migrated automatically the first time it's opened, attributing all
 previously-imported emails to the primary account.

 ## Run

 **stdio mode** (for MCP clients like Claude Desktop):
 ```bash
 node index.js
 ```

 **HTTP mode** (for remote or browser-based clients):
 ```bash
 node index.js --host=127.0.0.1 --port=3001
 ```

 ## Available Tools

 | Tool | Description |
 |------|-------------|
 | `imap_list_unseen` | List all UNSEEN emails in INBOX (returns UID, ACCOUNT, FROM, DATE, SUBJECT). Optional `account`; checks every configured account when omitted. |
 | `imap_fetch_email` | Fetch full email content by UID (returns text, html, date, etc.). Optional `account` (defaults to the primary account). |
 | `imap_mark_seen` | Mark one or more emails as seen by their UIDs — pass a JSON array, e.g. `[46]` or `[42, 46]`. Optional `account` (defaults to the primary account). |
 | `imap_import_recent` | Import emails not older than `days` from a mailbox (default `INBOX`), caching them in a local SQLite database tagged with which account they came from. Already-cached emails are skipped, not re-fetched. Optional `account`; imports from every configured account when omitted. |
 | `imap_list_cached` | List previously imported emails straight from the local SQLite cache, without contacting the IMAP server. Optional `days`, `mailbox`, `limit`, `account` (filter to one account's emails). |
 | `imap_write_draft` | Save a draft in the Entwurf folder (requires `to`, `subject`, `body`; optional `inReplyTo`, `references`, `account`) |


 ## Example Usage

 ```json
 // List unread emails
 {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imap_list_unseen"}}

 // Fetch a specific email
 {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"imap_fetch_email","arguments":{"uid":4824}}}

 // Mark emails as seen
 {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"imap_mark_seen","arguments":{"uids":[4824, 4825]}}}

// Import emails from the last 7 days into the local cache, from every configured account
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"imap_import_recent","arguments":{"days":7}}}

// Import from just one account
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"imap_import_recent","arguments":{"days":7,"account":"your-second@email.com"}}}

// List what's already cached, without hitting the IMAP server
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"imap_list_cached","arguments":{"days":7}}}

// List what's cached from just one account
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"imap_list_cached","arguments":{"days":7,"account":"your-second@email.com"}}}

// Write a draft
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"imap_write_draft","arguments":{"to":"user@example.com","subject":"Hello","body":"This is a draft."}}}

// Write a reply draft
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"imap_write_draft","arguments":{"to":"user@example.com","subject":"Re: Hello","body":"Reply text.","inReplyTo":"<msg-id@domain>","references":"<prev-id@domain>"}}}

 ```

 ## Protocol

 - **stdio**: JSON-RPC 2.0 over stdin/stdout
 - **HTTP**: Streamable HTTP on the configured port
 - Both modes support `--verbose` / `-v` for debug logging

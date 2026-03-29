# Simple Sync

Sync your Obsidian vault between devices using your own CouchDB server. No cloud service, no subscription, no data leaving your network unless you want it to.

## The problem

You have notes on your laptop and you want them on your phone. The options aren't great:

- **Obsidian Sync** works well, but it's $4/month and your notes live on someone else's server.
- **iCloud / Google Drive** work until they don't — duplicate files, sync delays, and the occasional silent conflict that quietly overwrites your edits.
- **Syncthing** is solid but doesn't run on iOS, and the Android app needs attention to stay alive in the background.
- **Git-based plugins** are powerful if you're comfortable with Git on every device. Most people aren't, especially on mobile.

Simple Sync takes a different path: your notes live in a CouchDB database that *you* run, sync happens instantly over HTTP, and when two devices edit the same note, both versions are preserved — never silently discarded. Four settings, and you're done.

## How it works

```
Your files ←→ PouchDB (local, inside Obsidian) ←→ CouchDB (your server)
```

1. When the plugin starts, it compares your local vault against its local PouchDB database and reconciles any differences.
2. It then starts **live bidirectional replication** between PouchDB and your CouchDB server.
3. Every local change (edit, create, delete, rename) is written to PouchDB within 300ms, then automatically replicated to CouchDB.
4. Every remote change arriving from CouchDB is written to your vault immediately.

Because PouchDB stores everything locally, **the plugin works offline**. Changes queue up and replicate when the connection returns. The status bar shows the current state: `Synced`, `Syncing...`, `Initial sync...`, or `Error`.

## What happens when there's a conflict

This is where most sync tools either silently lose data or leave you with a mess. Simple Sync is opinionated: **you should never lose work**.

### Text files (Markdown, JSON, YAML, etc.)

When two devices edit the same file before syncing, the newer version (by timestamp) wins and becomes the file content. The older version is saved as a conflict copy next to the original:

```
notes/
  meeting-notes.md                                ← newer version
  meeting-notes.conflict-2026-03-15T14-30-22.md   ← older version, fully preserved
```

Both versions are right there in your vault. You can diff them, merge them manually, or delete the conflict copy — whatever makes sense for that situation. The conflict file syncs to all devices like any other file, so you'll see it everywhere.

This is a deliberate choice. Automatic merging sounds appealing, but when it goes wrong you lose data silently. Conflict copies are noisy — you *notice* them — and that's the point.

### Binary files (images, PDFs, etc.)

Binary files can't be meaningfully diffed or merged. The newest version wins by timestamp. The older version is **not** preserved — binary conflict copies would bloat your vault quickly. If you have important binaries that change on multiple devices, consider version-controlling them separately.

### The philosophy

Most sync tools make you choose between "silent data loss" and "manual conflict resolution." Simple Sync picks a third option: keep both versions, put them where you can see them, and let you decide. No merge UI, no conflict markers embedded in your text, no decisions to make under pressure — just two files, clearly named.

## Getting started

### 1. Set up CouchDB

You need a CouchDB instance reachable from all your devices. There are a few ways to get one:

#### Option A: Docker (easiest for local/home network)

Create a `docker-compose.yml`:

```yaml
services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    ports:
      - "5984:5984"
    environment:
      COUCHDB_USER: admin
      COUCHDB_PASSWORD: changeme
    volumes:
      - couchdb_data:/opt/couchdb/data

volumes:
  couchdb_data:
```

```bash
docker compose up -d

# Create the sync database
curl -X PUT http://admin:changeme@localhost:5984/obsidian-sync
```

Enable CORS if Obsidian will connect directly (rather than through a reverse proxy): go to `http://localhost:5984/_utils` → Configuration → CORS → Enable for all origins.

For access outside your home network, run this on any cheap VPS and put it behind HTTPS (Caddy or nginx with Let's Encrypt) so your phone can connect securely.

### 2. Install the plugin

Install **Simple Sync** from the Obsidian Community Plugins browser, or manually copy `main.js` and `manifest.json` into `.obsidian/plugins/simple-sync/`.

### 3. Configure

Open **Settings → Simple Sync** and enter:

| Setting | Example |
|---------|---------|
| Server URL | `http://192.168.1.50:5984` or `https://couch.yourdomain.com` |
| Username | `admin` |
| Password | `changeme` |
| Database Name | `obsidian-sync` |

Hit **Test Connection** to verify, then close settings. Sync starts automatically.

### 4. Repeat on other devices

Install the plugin on your other devices with the same settings. The initial sync pulls down all existing notes.

## Limitations

- **You need a CouchDB server.** This is the main tradeoff — you're trading setup effort for control. If Docker or a VPS isn't your thing, [Obsidian Sync](https://obsidian.md/sync) exists and works well.
- **No end-to-end encryption.** Notes are stored as-is in CouchDB. Use HTTPS for transit encryption. For encryption at rest, enable it at the volume/filesystem level on your server.
- **No selective sync.** The entire vault syncs. There's no ignore list or folder filter.
- **No version history UI.** CouchDB keeps document revisions internally, but the plugin doesn't expose a "browse previous versions" interface.
- **Binary conflicts lose the older version.** Newest timestamp wins for images, PDFs, and other non-text files — no conflict copy is created.
- **Large vaults may have a slow first sync.** The initial reconciliation reads every file. Subsequent syncs are incremental and fast.

## FAQ

**Is this a replacement for Obsidian Sync?**
It solves the same core problem but makes different tradeoffs. Obsidian Sync is zero-setup and supports end-to-end encryption. Simple Sync is self-hosted and free but requires running your own server.

**Can multiple vaults sync to the same CouchDB?**
Yes — use a different database name per vault in the plugin settings.

**Does it work on iOS?**
It should — the plugin doesn't use any platform-specific APIs. But it hasn't been tested extensively on iOS yet. Reports welcome.

**What happens if my server goes down?**
Nothing bad. PouchDB keeps working locally. Your edits are saved and will sync when the connection returns. You'll see "Sync: Error" in the status bar until then.

**How much server resources does CouchDB need?**
Very little. The cheapest VPS you can find handles multiple vaults across multiple devices without issue.

## License

[MIT](LICENSE)

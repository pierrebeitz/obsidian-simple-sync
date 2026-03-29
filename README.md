# Simple Sync

Sync your Obsidian vault between devices using your own CouchDB server. No cloud service, no subscription, no data leaving your network unless you want it to.

## The problem

You have notes on your laptop and you want them on your phone. The options aren't great:

- **Obsidian Sync** works well, but it's $4/month and your notes live on someone else's server.
- **iCloud / Google Drive** cause sync conflicts that silently corrupt your vault. If you've lost a note to a `(1).md` shadow copy, you know.
- **Syncthing** is solid but doesn't run on iOS, and the Android app needs attention to keep alive.
- **Git-based plugins** are powerful if you're comfortable with Git on every device. Most people aren't, especially on mobile.

Simple Sync takes a different path: your notes live in a CouchDB database that *you* run, sync happens instantly over HTTP, and when two devices edit the same note, both versions are preserved. Four settings, and you're done.

## How it works

```
Your files ←→ PouchDB (local, inside Obsidian) ←→ CouchDB (your server)
```

1. When the plugin starts, it compares your local vault against its local PouchDB database and reconciles any differences.
2. It then starts **live bidirectional replication** between PouchDB and your CouchDB server.
3. Every local change (edit, create, delete, rename) is written to PouchDB within 300ms, then automatically replicated to CouchDB.
4. Every remote change arriving from CouchDB is written to your vault immediately.

Because PouchDB stores everything locally, **the plugin works offline**. Changes queue up and replicate when the connection returns.

## What happens when there's a conflict

This is where most sync tools either silently lose data or leave you with a mess. Simple Sync is opinionated about this: **you should never lose work**.

### Text files (Markdown, JSON, YAML, etc.)

When two devices edit the same file:

1. **If the edits don't overlap**, they're merged automatically using three-way merge. You added a paragraph at the top on your laptop, edited a bullet at the bottom on your phone — both changes land in the file. No conflict file, no intervention needed.

2. **If the edits conflict**, the plugin still attempts a merge (best-effort), but creates a conflict copy so you can review what couldn't be cleanly merged:

```
notes/
  meeting-notes.md              ← merged result (best effort)
  meeting-notes.conflict-2026-03-15T14-30-22.md  ← the other version
```

3. **If there's no common ancestor** (e.g., both devices created the same file independently), the newer version wins by timestamp, and the older version is saved as a conflict file. Nothing is discarded.

### Binary files (images, PDFs, etc.)

Binary files can't be merged. The newest version wins by timestamp. The older version is *not* preserved as a conflict copy — binary conflict files would bloat your vault quickly and there's no meaningful way to "diff" two images. If this matters to you, keep your binaries in version control elsewhere.

### The philosophy

Most sync tools make you choose between "silent data loss" and "manual conflict resolution." Simple Sync picks a third option: resolve automatically when possible, preserve both versions when not, and never make the user do busywork. The conflict files sync like any other file, so they'll show up on all your devices.

## Getting started

### 1. Set up CouchDB

You need a CouchDB instance accessible from all your devices. The easiest way to try it:

```bash
git clone https://github.com/pierrebeitz/obsidian-simple-sync
cd obsidian-simple-sync/server
bash setup.sh
```

This starts CouchDB in Docker on port 5984 with CORS enabled. Default credentials are `admin` / `password` — change them for anything beyond local testing.

For real use, run CouchDB on a VPS, NAS, or any machine your devices can reach. A $5/month VPS handles this easily. CouchDB is a single binary with no external dependencies — it's one of the simplest databases to self-host.

### 2. Install the plugin

Install "Simple Sync" from the Obsidian Community Plugins browser, or manually copy `main.js` and `manifest.json` into `.obsidian/plugins/simple-sync/`.

### 3. Configure

Open **Settings → Simple Sync** and enter:

| Setting | Example |
|---------|---------|
| Server URL | `http://192.168.1.50:5984` or `https://couch.yourdomain.com` |
| Username | `admin` |
| Password | `password` |
| Database Name | `obsidian-sync` |

Hit **Test Connection** to verify, then close settings. Sync starts automatically.

### 4. Repeat on other devices

Install the plugin on your other devices with the same settings. The initial sync will pull down all existing notes.

## Limitations

Being honest about what this plugin doesn't do:

- **You need to run a CouchDB server.** This is the main tradeoff. If you're not comfortable with Docker or a VPS, this plugin isn't for you — Obsidian Sync exists for a reason.
- **No end-to-end encryption.** Notes are stored as-is in CouchDB. Use HTTPS for transit encryption, and if you need encryption at rest, enable it at the filesystem/volume level on your server.
- **No selective sync.** The entire vault syncs. There's no ignore list or folder filter.
- **No version history UI.** CouchDB keeps revisions internally, but the plugin doesn't expose a "browse previous versions" interface.
- **Binary conflicts lose the older version.** As described above — newest timestamp wins for images, PDFs, and other non-text files.
- **Large vaults may have a slow first sync.** The initial reconciliation reads every file. After that, only changes are synced.

## FAQ

**Is this a replacement for Obsidian Sync?**
It solves the same core problem (sync your vault across devices) but makes different tradeoffs. Obsidian Sync is zero-setup and supports end-to-end encryption. Simple Sync is self-hosted and free but requires running your own server.

**Can multiple vaults sync to the same CouchDB?**
Yes — use a different database name for each vault.

**Does it work on iOS?**
It should — the plugin doesn't use any platform-specific APIs. But it hasn't been tested extensively on iOS yet. Reports welcome.

**What happens if my server goes down?**
Nothing bad. PouchDB keeps working locally. Your edits are saved normally and will sync when the server comes back. You'll see "Sync: Error" in the status bar until then.

**How much server resources does this need?**
Very little. CouchDB is lightweight. A small VPS (1 CPU, 512MB RAM) can handle multiple vaults across multiple devices without breaking a sweat.

## License

[MIT](LICENSE)

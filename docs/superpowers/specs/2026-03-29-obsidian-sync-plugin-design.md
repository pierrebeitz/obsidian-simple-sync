# Obsidian Sync Plugin — Design Spec

**Date:** 2026-03-29
**Status:** Draft
**Codename:** `sync` (plugin id: `simple-sync`)

## Problem

Obsidian users want to sync vaults between desktop and Android without paying for Obsidian Sync, without complex setup, and without ever thinking about conflicts. Existing solutions (livesync, remotely-save, git) are either too complex, too fragile, or require manual conflict resolution.

## Success Criteria

1. User installs plugin, enters a server URL + password, and sync works
2. Edits on desktop appear on Android within seconds (when online)
3. Edits made offline on both devices merge automatically when reconnected
4. Zero merge conflicts shown to the user in normal usage
5. Server deploys with `docker compose up -d`
6. Plugin works on both desktop and Android (iOS is a stretch goal)

## Architecture

```
┌──────────────────┐          ┌──────────────────┐
│  Desktop Client  │          │  Android Client  │
│                  │          │                  │
│  Obsidian Vault  │          │  Obsidian Vault  │
│       ↕          │          │       ↕          │
│  Sync Engine     │          │  Sync Engine     │
│       ↕          │          │       ↕          │
│  PouchDB         │          │  PouchDB         │
│  (IndexedDB)     │          │  (IndexedDB)     │
└───────┬──────────┘          └───────┬──────────┘
        │                             │
        │   CouchDB Replication       │
        │   Protocol (HTTPS)          │
        │                             │
        └──────────┬──────────────────┘
                   │
            ┌──────┴──────┐
            │   CouchDB   │
            │   (Docker)  │
            └─────────────┘
```

### Components

#### 1. Sync Engine (core of the plugin)

Bridges the Obsidian Vault API with PouchDB. Responsibilities:

- **File → DB**: When a vault file changes (create/modify/delete/rename), serialize it to a PouchDB document
- **DB → File**: When PouchDB receives a remote change via replication, write it to the vault
- **Conflict resolution**: When PouchDB detects a conflict, resolve it automatically

Document schema per file:
```typescript
interface SyncDocument {
  _id: string;          // vault-relative file path (e.g., "notes/daily.md")
  _rev: string;         // CouchDB revision (managed automatically)
  content: string;      // file content (text files)
  contentType: "text" | "binary";
  chunks?: string[];    // for binary/large files: array of chunk doc IDs
  mtime: number;        // last modified timestamp (ms)
  size: number;         // file size in bytes
  deleted?: boolean;    // soft-delete flag
  hash: string;         // MD5 of content for change detection
}
```

For binary files > 1MB, content is stored as chunks:
```typescript
interface ChunkDocument {
  _id: string;          // "chunk:<parent-id>:<index>"
  data: string;         // base64-encoded chunk (512KB each)
}
```

#### 2. Change Detection

**Local changes** (vault → PouchDB):
- Listen to `vault.on('create' | 'modify' | 'delete' | 'rename')`
- Debounce rapid changes (300ms) to avoid syncing mid-keystroke
- Compute MD5 hash; skip if hash matches stored version (avoids redundant writes)
- Guard against initial vault load events using `workspace.onLayoutReady()`

**Remote changes** (PouchDB → vault):
- PouchDB live replication fires `change` events
- Set a "syncing" flag to prevent echo (remote change → vault write → vault event → PouchDB write)
- Compare hash before writing to vault (skip if identical)

#### 3. Conflict Resolution

Strategy (automatic, zero user intervention):

1. PouchDB/CouchDB detect a conflict (two devices edited the same document)
2. CouchDB picks a deterministic winner (longest rev chain)
3. Our conflict resolver runs on each client:
   a. Fetch winning revision and all conflicting revisions
   b. Fetch the common ancestor (via revision history)
   c. Run **diff-match-patch three-way merge** (ancestor + rev A + rev B)
   d. If merge is clean → write merged content, delete losing revisions
   e. If merge fails → keep the revision with the latest `mtime`, save the other as `<filename>.sync-conflict-<timestamp>.md`
4. Conflict files are created only as an absolute last resort

For binary files: latest `mtime` wins. No merge attempted.

#### 4. Server (CouchDB)

Minimal docker-compose.yml:
```yaml
services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    ports:
      - "5984:5984"
    environment:
      COUCHDB_USER: admin
      COUCHDB_PASSWORD: ${COUCHDB_PASSWORD}
    volumes:
      - couchdb_data:/opt/couchdb/data
      - ./couchdb.ini:/opt/couchdb/etc/local.d/custom.ini

volumes:
  couchdb_data:
```

Custom config (`couchdb.ini`):
```ini
[chttpd]
enable_cors = true
bind_address = 0.0.0.0

[cors]
origins = *
methods = GET, PUT, POST, DELETE
credentials = true
headers = accept, authorization, content-type, origin, referer

[compactions]
_default = [{db_fragmentation, "70%"}, {view_fragmentation, "60%"}]
```

Database setup (automated by plugin on first connect):
- Creates a per-user database: `sync_<username>`
- Enables auto-compaction

#### 5. Settings UI

Minimal settings tab:
- **Server URL**: `https://your-server:5984`
- **Username**: text input
- **Password**: password input
- **Test Connection**: button that pings the server
- **Sync Status**: indicator (syncing/synced/offline/error)
- **Pause Sync**: toggle

That's it. No folder exclusions, no sync interval config, no advanced options.

## Data Flow

### Normal Edit (Online)
```
1. User edits note on Desktop
2. Vault fires 'modify' event
3. Sync engine debounces (300ms), reads file, computes hash
4. Hash differs from stored → write to PouchDB
5. PouchDB live replication pushes to CouchDB
6. CouchDB stores document
7. Android's PouchDB live replication pulls change
8. Sync engine writes to Android vault
9. Obsidian renders updated note
```

### Offline Edit + Reconnect
```
1. Desktop and Android both edit "daily.md" while offline
2. Each device writes its version to local PouchDB
3. Devices come online
4. PouchDB replication syncs both changes to CouchDB
5. CouchDB detects conflict, stores both revisions
6. Each client's conflict resolver:
   a. Fetches both revisions + common ancestor
   b. Runs three-way merge
   c. Writes clean merge, deletes losing revision
7. Both devices converge to identical content
```

### Initial Sync

Three scenarios when plugin first connects:

**Scenario 1: Existing vault, fresh server (most common)**
- Plugin detects empty remote DB
- Batch-scans local vault files (50 at a time)
- Bulk-writes to PouchDB via `bulkDocs`
- PouchDB replicates to CouchDB
- Progress notice: "Uploading 342/500 files..."

**Scenario 2: Fresh vault, existing server (adding second device)**
- Plugin detects empty local PouchDB, populated remote
- PouchDB replication pulls all docs
- Sync engine writes each doc to vault (with `syncing` flag to suppress echo)
- Progress notice: "Downloading 342/500 files..."

**Scenario 3: Both sides have content (re-linking)**
- Pull remote `_all_docs` with hashes
- Diff local vault against remote:
  - Local-only → push to PouchDB
  - Remote-only → pull to vault
  - Both exist, same hash → skip
  - Both exist, different hash → newer `mtime` wins, loser saved as `.sync-conflict` file
- After diff resolves, start live replication

All scenarios end by starting PouchDB live replication with `{live: true, retry: true}`.

Batching (50 files/batch) prevents UI blocking. A notice shows progress throughout.

## Technical Constraints

- **No Node.js APIs**: Everything through Obsidian's Vault API and PouchDB's HTTP replication
- **PouchDB in-browser**: Uses IndexedDB adapter (works on both desktop Electron and Android Capacitor)
- **No background sync**: Plugin only syncs while Obsidian is open (platform limitation)
- **File size limit**: Recommend <50MB per file; chunk anything >1MB

## MVP Scope

**In:**
- Text file sync (markdown, plaintext, JSON, YAML)
- Binary file sync (images, PDFs) with chunking
- Automatic conflict resolution
- Settings UI with connection test
- Status bar indicator (desktop only)
- Docker-compose server
- Debounced change detection

**Out (post-MVP):**
- End-to-end encryption
- iOS support (likely works but untested)
- Selective folder sync
- Version history UI
- Multi-vault support
- Shared/collaborative vaults

## Testing Strategy

1. **Unit tests**: Sync engine logic, conflict resolution, chunking
2. **Integration tests**: PouchDB ↔ CouchDB replication with test server
3. **Manual testing**: Desktop ↔ Android real-device sync
4. **Edge cases**: Simultaneous edits, large files, rapid edits, rename during sync, delete during sync, network interruption mid-sync

## File Structure

```
sync/
├── src/
│   ├── main.ts              # Plugin entry point
│   ├── sync-engine.ts       # Core sync logic
│   ├── conflict-resolver.ts # Three-way merge logic
│   ├── db.ts                # PouchDB wrapper
│   ├── chunker.ts           # Large file chunking
│   ├── hasher.ts            # MD5 hashing
│   ├── settings.ts          # Settings tab UI
│   ├── status.ts            # Status bar management
│   └── types.ts             # TypeScript interfaces
├── server/
│   ├── docker-compose.yml
│   └── couchdb.ini
├── test/
│   ├── sync-engine.test.ts
│   ├── conflict-resolver.test.ts
│   └── chunker.test.ts
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── README.md
```

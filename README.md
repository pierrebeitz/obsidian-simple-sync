# Simple Sync

Dead-simple Obsidian vault sync via CouchDB. Works across desktop and Android with zero cloud dependencies.

## Features

- **Bidirectional live sync** — changes propagate instantly between all devices via CouchDB
- **Automatic conflict resolution** — three-way merge using diff-match-patch; falls back to most-recent-wins for binary files
- **Large file support** — binary files over 1 MB are automatically chunked for reliable sync
- **Self-hosted** — you control your data; just point it at any CouchDB instance

## Setup

1. Install and enable the plugin
2. Open Settings → Simple Sync
3. Enter your CouchDB server URL, username, password, and database name
4. The plugin starts syncing automatically

### CouchDB Server

You need a running CouchDB instance. The included `server/setup.sh` script starts one via Docker:

```bash
cd server && bash setup.sh
```

This launches CouchDB on port 5984 with CORS enabled.

## How It Works

On startup the plugin diffs your local vault against the PouchDB database, then starts live bidirectional replication between PouchDB and CouchDB. Vault file events (create, modify, delete, rename) are written to PouchDB. Remote changes arriving via replication are written back to the vault. An echo-prevention mechanism ensures changes don't loop.

## Commands

| Command | Description |
|---------|-------------|
| **Force sync now** | Restart the sync engine |
| **Pause/Resume sync** | Toggle syncing on and off |

## Requirements

- Obsidian 1.0.0+
- A CouchDB 3.x instance accessible from your devices

## License

[MIT](LICENSE)

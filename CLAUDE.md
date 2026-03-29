# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Obsidian plugin ("Simple Sync") that syncs vaults between desktop and Android via CouchDB. Uses PouchDB locally with live bidirectional replication, automatic three-way merge conflict resolution, and chunking for large binary files.

## Commands

```bash
npm run check          # tsgo + eslint + unit tests (concurrent)
npm run test:e2e       # e2e tests against real CouchDB Docker container
npm run build          # production bundle → main.js
npm run dev            # watch mode with esbuild
npx vitest run test/db.test.ts   # run a single test file
```

Server: `cd server && bash setup.sh` starts CouchDB in Docker on port 5984.

## Architecture

```
Obsidian Vault ←→ SyncEngine ←→ SyncDatabase (PouchDB) ←→ CouchDB (Docker)
```

- **main.ts** — Plugin lifecycle, commands, settings wiring. Delegates everything to SyncEngine.
- **sync-engine.ts** — The core. Handles initial sync (diff local vault vs PouchDB), live sync (vault events → PouchDB, PouchDB replication → vault writes), and conflict resolution. Uses a `syncing` Set to prevent echo loops between vault events and replication.
- **db.ts** — PouchDB wrapper. Every public method returns `Result<T>` (never throws). Manages two PouchDB instances pointing at the same IndexedDB — one typed for `SyncDocument`, one for `ChunkDocument`.
- **conflict-resolver.ts** — Three-way merge via diff-match-patch. Falls back to mtime-wins for binary or when no ancestor is available.
- **result.ts** — `Result<T, E>` discriminated union with `ok()`, `err()`, `tryAsync()`, `unwrapOr()`.
- **schemas.ts** — Zod schemas for validating PouchDB responses and replication events at runtime boundaries.

## Code Conventions (enforced by tooling)

- **No `throw`** — All fallible operations return `Result<T>`. Use `tryAsync()` to wrap external APIs that throw.
- **No type assertions** — `as X` is banned (`consistent-type-assertions: "never"`). Use converter functions, Zod validation, or typed variables instead.
- **No `!` assertions** — `no-non-null-assertion: "error"`.
- **No `any`** — `no-explicit-any` with `fixToUnknown: true`. Use Zod for unknown external data.
- **No truthy checks** — `strict-boolean-expressions` bans `if (x)` for nullable/string/number. Use explicit comparisons (`x !== null`, `x !== ""`).
- **Explicit everything** — Return types, member accessibility (`public`/`private`), `import type` for type-only imports.
- **FP-leaning** — Prefer `Result` over try/catch, `unwrapOr` over conditional chains, `flatMap` over filter+map.
- **Single-line early returns** — `curly: "multi"` allows braceless `if (x) return;`.
- **Type checker** — `tsgo` (Go-based TypeScript, `@typescript/native-preview`).
- **Prettier** — 140 char line width, double quotes.

## Key Patterns

**PouchDB error handling** — PouchDB throws objects with a `status` field. Use `getPouchDBErrorStatus(err)` from schemas.ts to safely extract it, then match on 404/409.

**Echo prevention** — When writing to the vault from a remote change, the path is added to `SyncEngine.syncing` Set. Vault event handlers skip paths in this set to prevent infinite sync loops.

**Chunking** — Binary files >1MB are split into 512KB base64 chunks stored as separate `ChunkDocument`s. The parent `SyncDocument` stores chunk IDs in `chunks[]` with empty `content`.

**Test setup** — Unit tests use an in-memory PouchDB adapter (see `test/pouchdb-node.ts`). The vitest config aliases `pouchdb-browser` to this shim so `SyncDatabase` works in Node without modification. E2e tests spin up a real CouchDB container on a random port.

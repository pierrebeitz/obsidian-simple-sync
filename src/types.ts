/** Document stored in PouchDB/CouchDB representing a vault file */
export interface SyncDocument {
  _id: string;
  _rev?: string | undefined;
  content: string;
  contentType: "text" | "binary";
  chunks?: string[] | undefined;
  mtime: number;
  size: number;
  hash: string;
  _conflicts?: string[] | undefined;
}

/** Chunk document for large/binary files */
export interface ChunkDocument {
  _id: string;
  _rev?: string | undefined;
  data: string;
}

/** Plugin settings persisted to data.json */
export interface SyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  dbName: string;
  paused: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "",
  username: "",
  password: "",
  dbName: "obsidian-sync",
  paused: false,
};

/** Sync status for the status bar */
export type SyncStatus = "idle" | "syncing" | "synced" | "error" | "initial-sync";

/** Batch size for initial sync and bulk operations */
export const BATCH_SIZE = 50;

/** Chunk size for large files (512KB) */
export const CHUNK_SIZE: number = 512 * 1024;

/** Files larger than this are chunked (1MB) */
export const CHUNK_THRESHOLD: number = 1024 * 1024;

/** Debounce delay for vault change events (ms) */
export const DEBOUNCE_MS = 300;

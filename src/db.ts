import PouchDB from "pouchdb-browser";
import type { SyncDocument, ChunkDocument, SyncSettings } from "./types";
import { getPouchDBErrorStatus } from "./schemas";
import { type Result, ok, tryAsync } from "./result";

/**
 * Extract SyncDocument fields from a PouchDB result object.
 * PouchDB returns documents with extra metadata (_attachments, _revs_info, etc.)
 * that are not part of our SyncDocument type. This function picks only the fields
 * we care about, avoiding type assertions.
 */
function toSyncDocument(doc: {
  _id: string;
  _rev?: string | undefined;
  content: string;
  contentType: "text" | "binary";
  chunks?: string[] | undefined;
  mtime: number;
  size: number;
  deleted?: boolean | undefined;
  hash: string;
  _conflicts?: string[] | undefined;
}): SyncDocument {
  return {
    _id: doc._id,
    _rev: doc._rev,
    content: doc.content,
    contentType: doc.contentType,
    chunks: doc.chunks,
    mtime: doc.mtime,
    size: doc.size,
    deleted: doc.deleted,
    hash: doc.hash,
    _conflicts: doc._conflicts,
  };
}

/**
 * Extract ChunkDocument fields from a PouchDB result object.
 */
function toChunkDocument(doc: { _id: string; _rev?: string | undefined; data: string }): ChunkDocument {
  return {
    _id: doc._id,
    _rev: doc._rev,
    data: doc.data,
  };
}

export class SyncDatabase {
  /** Typed PouchDB instance for SyncDocument operations and replication. */
  private readonly local: PouchDB.Database<SyncDocument>;

  /**
   * Typed PouchDB instance for ChunkDocument operations.
   * Points to the same underlying database as `local` — PouchDB is schemaless,
   * so both instances share the same IndexedDB store.
   */
  private readonly chunkDb: PouchDB.Database<ChunkDocument>;

  private remote: PouchDB.Database<SyncDocument> | null = null;
  private replication: PouchDB.Replication.Sync<SyncDocument> | null = null;

  public constructor(dbName: string) {
    this.local = new PouchDB<SyncDocument>(dbName);
    this.chunkDb = new PouchDB<ChunkDocument>(dbName);
  }

  /**
   * Connect to remote CouchDB and start live replication.
   * Returns a replication object that emits 'change', 'error', 'paused', 'active' events.
   * The onChange callback is called for each batch of remote changes.
   */
  public startSync(
    settings: SyncSettings,
    onChange: (change: PouchDB.Replication.SyncResult<SyncDocument>) => void,
    onError: (err: Error) => void,
    onPaused: () => void,
    onActive: () => void,
  ): void {
    // Stop any existing replication first
    this.stopSync();

    const remoteUrl = `${settings.serverUrl}/${settings.dbName}`;
    const remoteOptions: PouchDB.Configuration.RemoteDatabaseConfiguration = {
      auth: {
        username: settings.username,
        password: settings.password,
      },
    };
    this.remote = new PouchDB<SyncDocument>(remoteUrl, remoteOptions);

    const syncOptions: PouchDB.Replication.SyncOptions = {
      live: true,
      retry: true,
      batch_size: 50,
    };
    this.replication = this.local.sync(this.remote, syncOptions);

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- .on() chains return the sync object (thenable) but we use it for event registration only
    this.replication
      .on("change", (info) => {
        onChange(info);
      })
      .on("error", (err: unknown) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      })
      .on("paused", () => {
        onPaused();
      })
      .on("active", () => {
        onActive();
      });
  }

  /** Stop live replication */
  public stopSync(): void {
    if (this.replication !== null) {
      this.replication.cancel();
      this.replication = null;
    }
    this.remote = null;
  }

  /** Test connection to remote CouchDB. Returns true if successful. */
  public async testConnection(settings: SyncSettings): Promise<boolean> {
    try {
      const remoteUrl = `${settings.serverUrl}/${settings.dbName}`;
      const remoteOptions: PouchDB.Configuration.RemoteDatabaseConfiguration = {
        auth: {
          username: settings.username,
          password: settings.password,
        },
        skip_setup: true,
      };
      const testDb = new PouchDB<SyncDocument>(remoteUrl, remoteOptions);
      await testDb.info();
      return true;
    } catch {
      return false;
    }
  }

  /** Get a document by ID (file path). Returns null if not found. */
  public async get(id: string): Promise<Result<SyncDocument | null>> {
    const result = await tryAsync(async () => this.local.get(id, { conflicts: true }));
    if (result.ok) return ok(toSyncDocument(result.value));
    if (getPouchDBErrorStatus(result.error) === 404) return ok(null);
    return result;
  }

  /** Put a document (create or update). Handles rev conflicts by fetching latest rev first. */
  public async put(doc: SyncDocument): Promise<Result<void>> {
    const result = await tryAsync(async () => {
      await this.local.put(doc);
    });
    if (result.ok) return ok(undefined);
    if (getPouchDBErrorStatus(result.error) !== 409) return result;
    // Conflict: fetch latest rev and retry
    const existing = await tryAsync(async () => this.local.get(doc._id));
    if (!existing.ok) return existing;
    doc._rev = existing.value._rev;
    return tryAsync(async () => {
      await this.local.put(doc);
    });
  }

  /** Delete a document by marking it with _deleted flag */
  public async remove(id: string): Promise<Result<void>> {
    const getResult = await tryAsync(async () => this.local.get(id));
    if (!getResult.ok) {
      if (getPouchDBErrorStatus(getResult.error) === 404) return ok(undefined);
      return getResult;
    }
    return tryAsync(async () => {
      await this.local.remove(getResult.value);
    });
  }

  /** Bulk insert/update documents */
  public async bulkPut(docs: SyncDocument[]): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.local.bulkDocs(docs);
    });
  }

  /** Get all documents (for initial sync comparison) */
  public async getAllDocs(): Promise<Result<SyncDocument[]>> {
    return tryAsync(async () => {
      const result = await this.local.allDocs({ include_docs: true });
      return result.rows.flatMap((row) => {
        if (row.doc === undefined || row.id.startsWith("_design/")) return [];

        return [toSyncDocument(row.doc)];
      });
    });
  }

  /** Get all documents that have conflicts */
  public async getConflicts(): Promise<Result<SyncDocument[]>> {
    return tryAsync(async () => {
      const result = await this.local.allDocs({
        include_docs: true,
        conflicts: true,
      });
      return result.rows.flatMap((row) => {
        if (row.doc === undefined) return [];
        if (row.doc._conflicts === undefined || row.doc._conflicts.length === 0) return [];

        return [toSyncDocument(row.doc)];
      });
    });
  }

  /** Get a specific revision of a document */
  public async getRevision(id: string, rev: string): Promise<Result<SyncDocument | null>> {
    const result = await tryAsync(async () => this.local.get(id, { rev }));
    if (result.ok) return ok(toSyncDocument(result.value));
    if (getPouchDBErrorStatus(result.error) === 404) return ok(null);
    return result;
  }

  /** Delete a specific conflict revision */
  public async removeConflict(id: string, rev: string): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.local.remove(id, rev);
    });
  }

  /** Put a chunk document */
  public async putChunk(chunk: ChunkDocument): Promise<Result<void>> {
    const result = await tryAsync(async () => {
      await this.chunkDb.put(chunk);
    });
    if (result.ok) return ok(undefined);
    if (getPouchDBErrorStatus(result.error) !== 409) return result;
    // Conflict: fetch latest rev and retry
    const existing = await tryAsync(async () => this.chunkDb.get(chunk._id));
    if (!existing.ok) return existing;
    chunk._rev = existing.value._rev;
    return tryAsync(async () => {
      await this.chunkDb.put(chunk);
    });
  }

  /** Get chunks for a parent document */
  public async getChunks(parentId: string): Promise<Result<ChunkDocument[]>> {
    return tryAsync(async () => {
      const result = await this.chunkDb.allDocs({
        include_docs: true,
        startkey: `chunk:${parentId}:`,
        endkey: `chunk:${parentId}:\uffff`,
      });
      return result.rows.flatMap((row) => {
        if (row.doc === undefined) return [];

        return [toChunkDocument(row.doc)];
      });
    });
  }

  /** Bulk put chunks */
  public async bulkPutChunks(chunks: ChunkDocument[]): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.chunkDb.bulkDocs(chunks);
    });
  }

  /** Destroy the local database */
  public async destroy(): Promise<Result<void>> {
    this.stopSync();
    return tryAsync(async () => {
      await this.local.destroy();
    });
  }
}

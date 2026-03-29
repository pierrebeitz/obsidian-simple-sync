import PouchDB from "pouchdb-browser";
import type { SyncDocument, ChunkDocument, SyncSettings } from "./types";
import { getPouchDBErrorStatus } from "./schemas";
import { type Result, ok, tryAsync } from "./result";

/**
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
    hash: doc.hash,
    _conflicts: doc._conflicts,
  };
}

function toChunkDocument(doc: { _id: string; _rev?: string | undefined; data: string }): ChunkDocument {
  return {
    _id: doc._id,
    _rev: doc._rev,
    data: doc.data,
  };
}

export class SyncDatabase {
  private readonly local: PouchDB.Database<SyncDocument>;

  /**
   * Points to the same underlying database as `local` — PouchDB is schemaless,
   * so both instances share the same IndexedDB store. Typed separately for
   * ChunkDocument operations.
   */
  private readonly chunkDb: PouchDB.Database<ChunkDocument>;

  private replication: PouchDB.Replication.Sync<SyncDocument> | null = null;

  public constructor(dbName: string) {
    this.local = new PouchDB<SyncDocument>(dbName);
    this.chunkDb = new PouchDB<ChunkDocument>(dbName);
  }

  /**
   * Puts a document with automatic conflict retry.
   * On 409 conflict, fetches the latest rev and retries once.
   * Spreads the doc instead of mutating it to avoid side effects.
   */
  private async putWithRetry<T extends { _id: string; _rev?: string | undefined }>(db: PouchDB.Database<T>, doc: T): Promise<Result<void>> {
    const result = await tryAsync(async () => {
      await db.put(doc);
    });
    if (result.ok) return ok(undefined);
    if (getPouchDBErrorStatus(result.error) !== 409) return result;
    const existing = await tryAsync(async () => db.get(doc._id));
    if (!existing.ok) return existing;
    const retryDoc = { ...doc, _rev: existing.value._rev };
    return tryAsync(async () => {
      await db.put(retryDoc);
    });
  }

  /**
   * Fetches a document by ID, returning null for 404s instead of erroring.
   */
  private async getOrNull(id: string, opts?: PouchDB.Core.GetOptions): Promise<Result<SyncDocument | null>> {
    const result = await tryAsync(async () => this.local.get(id, opts));
    if (result.ok) return ok(toSyncDocument(result.value));
    if (getPouchDBErrorStatus(result.error) === 404) return ok(null);
    return result;
  }

  private static buildRemote(settings: SyncSettings, extra?: { skip_setup?: boolean }): PouchDB.Database<SyncDocument> {
    const url = `${settings.serverUrl}/${settings.dbName}`;
    const options: PouchDB.Configuration.RemoteDatabaseConfiguration = {
      auth: { username: settings.username, password: settings.password },
      ...extra,
    };
    return new PouchDB<SyncDocument>(url, options);
  }

  /**
   * Connect to remote CouchDB and start live replication.
   * The onChange callback is called for each batch of remote changes.
   */
  public startSync(
    settings: SyncSettings,
    onChange: (change: PouchDB.Replication.SyncResult<SyncDocument>) => void,
    onError: (err: Error) => void,
    onPaused: () => void,
    onActive: () => void,
  ): void {
    this.stopSync();

    const remote = SyncDatabase.buildRemote(settings);

    const syncOptions: PouchDB.Replication.SyncOptions = {
      live: true,
      retry: true,
      batch_size: 50,
    };
    this.replication = this.local.sync(remote, syncOptions);

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

  public stopSync(): void {
    if (this.replication !== null) {
      this.replication.cancel();
      this.replication = null;
    }
  }

  /** Returns true if the remote CouchDB is reachable with the given credentials. */
  public static async testConnection(settings: SyncSettings): Promise<boolean> {
    try {
      const testDb = SyncDatabase.buildRemote(settings, { skip_setup: true });
      await testDb.info();
      return true;
    } catch {
      return false;
    }
  }

  public async get(id: string): Promise<Result<SyncDocument | null>> {
    return this.getOrNull(id, { conflicts: true });
  }

  public async put(doc: SyncDocument): Promise<Result<void>> {
    return this.putWithRetry(this.local, doc);
  }

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

  public async bulkPut(docs: SyncDocument[]): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.local.bulkDocs(docs);
    });
  }

  public async getAllDocs(): Promise<Result<SyncDocument[]>> {
    return tryAsync(async () => {
      const result = await this.local.allDocs({ include_docs: true });
      return result.rows.flatMap((row) => {
        if (row.doc === undefined || row.id.startsWith("_design/")) return [];

        return [toSyncDocument(row.doc)];
      });
    });
  }

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

  public async getRevision(id: string, rev: string): Promise<Result<SyncDocument | null>> {
    return this.getOrNull(id, { rev });
  }

  public async removeConflict(id: string, rev: string): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.local.remove(id, rev);
    });
  }

  public async putChunk(chunk: ChunkDocument): Promise<Result<void>> {
    return this.putWithRetry(this.chunkDb, chunk);
  }

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

  public async bulkPutChunks(chunks: ChunkDocument[]): Promise<Result<void>> {
    return tryAsync(async () => {
      await this.chunkDb.bulkDocs(chunks);
    });
  }

  public async destroy(): Promise<Result<void>> {
    this.stopSync();
    return tryAsync(async () => {
      await this.local.destroy();
    });
  }
}

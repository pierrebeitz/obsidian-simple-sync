import PouchDB from 'pouchdb-browser';
import type { SyncDocument, ChunkDocument, SyncSettings } from './types';
import { getPouchDBErrorStatus } from './schemas';

export class SyncDatabase {
  private readonly local: PouchDB.Database<SyncDocument>;
  private remote: PouchDB.Database<SyncDocument> | null = null;
  private replication: PouchDB.Replication.Sync<SyncDocument> | null = null;

  public constructor(dbName: string) {
    this.local = new PouchDB<SyncDocument>(dbName);
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
this.remote = new PouchDB<SyncDocument>(remoteUrl, {
      auth: {
        username: settings.username,
        password: settings.password,
      },
    } as PouchDB.Configuration.RemoteDatabaseConfiguration);

    this.replication = this.local.sync(this.remote, {
      live: true,
      retry: true,
      batch_size: 50,
      conflicts: true,
    } as PouchDB.Replication.SyncOptions);

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- .on() chains return the sync object (thenable) but we use it for event registration only
    this.replication
      .on('change', (info) => {
        onChange(info);
      })
      .on('error', (err) => {
        onError(err as Error);
      })
      .on('paused', () => {
        onPaused();
      })
      .on('active', () => {
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
    const testDb = new PouchDB<SyncDocument>(remoteUrl, {
        auth: {
          username: settings.username,
          password: settings.password,
        },
        skip_setup: true,
      } as PouchDB.Configuration.RemoteDatabaseConfiguration);
      await testDb.info();
      return true;
    } catch {
      return false;
    }
  }

  /** Get a document by ID (file path). Returns null if not found. */
  public async get(id: string): Promise<SyncDocument | null> {
    try {
      const doc = await this.local.get(id, { conflicts: true });
      return doc as SyncDocument;
    } catch (err: unknown) {
      if (getPouchDBErrorStatus(err) === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Put a document (create or update). Handles rev conflicts by fetching latest rev first. */
  public async put(doc: SyncDocument): Promise<void> {
    try {
      await this.local.put(doc);
    } catch (err: unknown) {
      if (getPouchDBErrorStatus(err) === 409) {
        // Conflict: fetch latest rev and retry
        const existing = await this.local.get(doc._id);
        doc._rev = existing._rev;
        await this.local.put(doc);
      } else {
        throw err;
      }
    }
  }

  /** Delete a document by marking it with _deleted flag */
  public async remove(id: string): Promise<void> {
    try {
      const doc = await this.local.get(id);
      await this.local.remove(doc);
    } catch (err: unknown) {
      if (getPouchDBErrorStatus(err) === 404) {
        // Already deleted, nothing to do
        return;
      }
      throw err;
    }
  }

  /** Bulk insert/update documents */
  public async bulkPut(docs: SyncDocument[]): Promise<void> {
    await this.local.bulkDocs(docs);
  }

  /** Get all documents (for initial sync comparison) */
  public async getAllDocs(): Promise<SyncDocument[]> {
    const result = await this.local.allDocs({ include_docs: true });
    return result.rows
      .filter((row) => row.doc !== undefined && !row.id.startsWith('_design/'))
      .map((row) => row.doc as SyncDocument);
  }

  /** Get all documents that have conflicts */
  public async getConflicts(): Promise<SyncDocument[]> {
    const result = await this.local.allDocs({
      include_docs: true,
      conflicts: true,
    });
    return result.rows
      .filter((row) => {
        if (row.doc === undefined) { return false; }
        const doc = row.doc as SyncDocument;
        return doc._conflicts !== undefined && doc._conflicts.length > 0;
      })
      .map((row) => row.doc as SyncDocument);
  }

  /** Get a specific revision of a document */
  public async getRevision(id: string, rev: string): Promise<SyncDocument | null> {
    try {
      const doc = await this.local.get(id, { rev });
      return doc as SyncDocument;
    } catch (err: unknown) {
      if (getPouchDBErrorStatus(err) === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Delete a specific conflict revision */
  public async removeConflict(id: string, rev: string): Promise<void> {
    await this.local.remove(id, rev);
  }

  /** Put a chunk document */
  public async putChunk(chunk: ChunkDocument): Promise<void> {
const db = this.local as unknown as PouchDB.Database<ChunkDocument>;
    try {
      await db.put(chunk);
    } catch (err: unknown) {
      if (getPouchDBErrorStatus(err) === 409) {
        const existing = await db.get(chunk._id);
        chunk._rev = existing._rev;
        await db.put(chunk);
      } else {
        throw err;
      }
    }
  }

  /** Get chunks for a parent document */
  public async getChunks(parentId: string): Promise<ChunkDocument[]> {
const db = this.local as unknown as PouchDB.Database<ChunkDocument>;
    const result = await db.allDocs({
      include_docs: true,
      startkey: `chunk:${parentId}:`,
      endkey: `chunk:${parentId}:\uffff`,
    });
    return result.rows
      .filter((row) => row.doc !== undefined)
      .map((row) => row.doc as ChunkDocument);
  }

  /** Bulk put chunks */
  public async bulkPutChunks(chunks: ChunkDocument[]): Promise<void> {
const db = this.local as unknown as PouchDB.Database<ChunkDocument>;
    await db.bulkDocs(chunks);
  }

  /** Destroy the local database */
  public async destroy(): Promise<void> {
    this.stopSync();
    await this.local.destroy();
  }
}

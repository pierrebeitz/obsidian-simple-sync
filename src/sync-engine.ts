import { type App, TFile, Notice, type EventRef } from "obsidian";
import { SyncDatabase } from "./db";
import { computeHash, computeHashBinary } from "./hasher";
import { splitIntoChunks, reassembleChunks } from "./chunker";
import { resolveConflict } from "./conflict-resolver";
import { RawSyncDocSchema } from "./schemas";
import { type SyncDocument, type SyncSettings, type SyncStatus, BATCH_SIZE, CHUNK_THRESHOLD, DEBOUNCE_MS } from "./types";

// --- Utility: text file extensions ---

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "css",
  "js",
  "ts",
  "jsx",
  "tsx",
  "html",
  "xml",
  "csv",
  "svg",
  "mmd",
  "canvas",
]);

function isTextFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

// --- Utility: ArrayBuffer <-> base64 ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return bytes.buffer;
}

// --- Utility: generate conflict file path ---

function conflictFilePath(originalPath: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dotIdx = originalPath.lastIndexOf(".");
  if (dotIdx === -1) return `${originalPath}.conflict-${timestamp}`;

  const base = originalPath.slice(0, dotIdx);
  const ext = originalPath.slice(dotIdx);
  return `${base}.conflict-${timestamp}${ext}`;
}

// --- Utility: ensure parent folder exists ---

async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  if (parts.length <= 1) return;
  // file at vault root

  // Build folder path by removing the file name
  const folderPath = parts.slice(0, -1).join("/");
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (existing !== null) return;

  // Create all ancestor folders iteratively
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) continue;

    current = current !== "" ? `${current}/${part}` : part;
    const folder = app.vault.getAbstractFileByPath(current);
    if (folder === null)
      try {
        await app.vault.createFolder(current);
      } catch {
        // Folder may have been created concurrently — that's fine
      }
  }
}

// --- SyncEngine ---

export class SyncEngine {
  private db: SyncDatabase;
  private readonly app: App;
  private settings: SyncSettings;
  private status: SyncStatus = "idle";
  private readonly statusListeners: ((status: SyncStatus) => void)[] = [];

  /** Echo prevention: tracks paths currently being written by remote sync */
  private readonly syncing = new Set<string>();

  /** Debounce timers for vault change events */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Vault event refs for cleanup */
  private eventRefs: EventRef[] = [];

  public constructor(app: App, settings: SyncSettings) {
    this.app = app;
    this.settings = settings;
    this.db = new SyncDatabase(`simple-sync-${settings.dbName}`);
  }

  /** Register a listener for status changes */
  public onStatusChange(listener: (status: SyncStatus) => void): void {
    this.statusListeners.push(listener);
  }

  /** Start the sync engine. Performs initial sync, then starts live sync. */
  public async start(): Promise<void> {
    try {
      this.setStatus("initial-sync");
      await this.initialSync();
      this.startLiveSync();
      this.setStatus("synced");
    } catch (err) {
       
      console.error("[SyncEngine] Failed to start:", err);
      this.setStatus("error");
      throw err;
    }
  }

  /** Stop the sync engine. Cancels replication and removes vault listeners. */
  public stop(): void {
    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);

    this.debounceTimers.clear();

    // Unregister vault event listeners
    for (const ref of this.eventRefs) this.app.vault.offref(ref);

    this.eventRefs = [];

    // Stop PouchDB replication
    this.db.stopSync();

    this.setStatus("idle");
  }

  /** Update settings (e.g., after user changes them). Restarts sync. */
  public async updateSettings(settings: SyncSettings): Promise<void> {
    this.stop();
    this.settings = settings;
    this.db = new SyncDatabase(`simple-sync-${settings.dbName}`);
    if (!settings.paused) await this.start();
  }

  /** Get current sync status */
  public getStatus(): SyncStatus {
    return this.status;
  }

  // ---------------------------------------------------------------------------
  // Initial sync
  // ---------------------------------------------------------------------------

  /** Perform initial sync between local vault and PouchDB */
  private async initialSync(): Promise<void> {
    const localFiles = this.app.vault.getFiles();
    const remoteDocs = await this.db.getAllDocs();

    // Build lookup maps
    const localMap = new Map<string, TFile>();
    for (const file of localFiles) localMap.set(file.path, file);

    const remoteMap = new Map<string, SyncDocument>();
    for (const doc of remoteDocs) remoteMap.set(doc._id, doc);

    // Categorize
    const localOnly: TFile[] = [];
    const remoteOnly: SyncDocument[] = [];
    const both: { file: TFile; doc: SyncDocument }[] = [];

    for (const file of localFiles) {
      const doc = remoteMap.get(file.path);
      if (doc !== undefined) both.push({ file, doc });
      else localOnly.push(file);
    }

    for (const doc of remoteDocs) if (!localMap.has(doc._id)) remoteOnly.push(doc);

    const total = localOnly.length + remoteOnly.length + both.length;
    let progress = 0;

    const reportProgress = (): void => {
      if (total > 0) new Notice(`Syncing ${String(progress)}/${String(total)} files...`);
    };

    // 1. Local-only files -> push to PouchDB in batches
    for (let i = 0; i < localOnly.length; i += BATCH_SIZE) {
      const batch = localOnly.slice(i, i + BATCH_SIZE);
      const docs: SyncDocument[] = [];
      for (const file of batch)
        try {
          const doc = await this.fileToDoc(file);
          docs.push(doc);
        } catch (err) {
           
          console.error(`[SyncEngine] Failed to read local file ${file.path}:`, err);
        }

      if (docs.length > 0) await this.db.bulkPut(docs);

      progress += batch.length;
      reportProgress();
    }

    // 2. Remote-only docs -> write to vault in batches
    for (let i = 0; i < remoteOnly.length; i += BATCH_SIZE) {
      const batch = remoteOnly.slice(i, i + BATCH_SIZE);
      for (const doc of batch)
        try {
          this.syncing.add(doc._id);
          await this.writeToVault(doc);
        } catch (err) {
           
          console.error(`[SyncEngine] Failed to write remote doc ${doc._id}:`, err);
        } finally {
          this.syncing.delete(doc._id);
        }

      progress += batch.length;
      reportProgress();
    }

    // 3. Files that exist on both sides — compare hashes
    for (let i = 0; i < both.length; i += BATCH_SIZE) {
      const batch = both.slice(i, i + BATCH_SIZE);
      for (const { file, doc } of batch)
        try {
          const localDoc = await this.fileToDoc(file);

          if (localDoc.hash === doc.hash)
            // Identical — nothing to do
            continue;

          // Different content: newer mtime wins
          if (localDoc.mtime >= doc.mtime) {
            // Local is newer — push to PouchDB
            if (doc._rev !== undefined) localDoc._rev = doc._rev;

            await this.db.put(localDoc);
          } else {
            // Remote is newer — write to vault
            this.syncing.add(doc._id);
            try {
              await this.writeToVault(doc);
            } finally {
              this.syncing.delete(doc._id);
            }
          }
        } catch (err) {
           
          console.error(`[SyncEngine] Failed to reconcile ${file.path}:`, err);
        }

      progress += batch.length;
      reportProgress();
    }

    if (total > 0) new Notice("Sync complete.");
  }

  // ---------------------------------------------------------------------------
  // Live sync
  // ---------------------------------------------------------------------------

  /** Start live replication and vault event listeners */
  private startLiveSync(): void {
    // Register vault event listeners once the layout is ready
    this.app.workspace.onLayoutReady(() => {
      // Create
      const createRef = this.app.vault.on("create", (file) => {
        if (file instanceof TFile && !this.syncing.has(file.path)) this.handleLocalChange(file);
      });
      this.eventRefs.push(createRef);

      // Modify
      const modifyRef = this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && !this.syncing.has(file.path)) this.handleLocalChange(file);
      });
      this.eventRefs.push(modifyRef);

      // Delete
      const deleteRef = this.app.vault.on("delete", (file) => {
        if (!this.syncing.has(file.path))
          this.handleLocalDelete(file.path).catch((err: unknown) => {
             
            console.error(`[SyncEngine] Failed to handle delete for ${file.path}:`, err);
          });
      });
      this.eventRefs.push(deleteRef);

      // Rename
      const renameRef = this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile)
          this.handleLocalRename(file, oldPath).catch((err: unknown) => {
             
            console.error(`[SyncEngine] Failed to handle rename for ${file.path}:`, err);
          });
      });
      this.eventRefs.push(renameRef);
    });

    // Start PouchDB bidirectional replication
    this.db.startSync(
      this.settings,
      (change) => {
        this.handleRemoteChanges(change).catch((err: unknown) => {
           
          console.error("[SyncEngine] Failed to handle remote changes:", err);
        });
      },
      (err) => {
         
        console.error("[SyncEngine] Replication error:", err);
        this.setStatus("error");
      },
      () => {
        // Paused (up-to-date or offline)
        if (this.status !== "error") this.setStatus("synced");
      },
      () => {
        // Active (replication resumed)
        this.setStatus("syncing");
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Local change handlers
  // ---------------------------------------------------------------------------

  /** Handle a local vault file change (debounced) */
  private handleLocalChange(file: TFile): void {
    const existing = this.debounceTimers.get(file.path);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      this.processLocalChange(file).catch((err: unknown) => {
         
        console.error(`[SyncEngine] Failed to process local change for ${file.path}:`, err);
      });
    }, DEBOUNCE_MS);

    this.debounceTimers.set(file.path, timer);
  }

  /** Actually process a local file change after debounce */
  private async processLocalChange(file: TFile): Promise<void> {
    try {
      const doc = await this.fileToDoc(file);

      // Check if the content actually changed
      const existing = await this.db.get(file.path);
      if (existing?.hash === doc.hash) return; // No real change

      // Carry forward the _rev so PouchDB can update
      if (existing !== null) if (existing._rev !== undefined) doc._rev = existing._rev;

      await this.db.put(doc);
    } catch (err) {
       
      console.error(`[SyncEngine] Failed to process local change for ${file.path}:`, err);
    }
  }

  /** Handle a local vault file deletion */
  private async handleLocalDelete(path: string): Promise<void> {
    if (this.syncing.has(path)) return;

    try {
      await this.db.remove(path);
    } catch (err) {
       
      console.error(`[SyncEngine] Failed to process local delete for ${path}:`, err);
    }
  }

  /** Handle a local vault file rename */
  private async handleLocalRename(file: TFile, oldPath: string): Promise<void> {
    try {
      // Create doc at new path
      const doc = await this.fileToDoc(file);
      await this.db.put(doc);

      // Remove doc at old path
      await this.db.remove(oldPath);
    } catch (err) {
       
      console.error(`[SyncEngine] Failed to process rename ${oldPath} -> ${file.path}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Remote change handlers
  // ---------------------------------------------------------------------------

  /** Handle remote changes received via PouchDB replication */
  private async handleRemoteChanges(change: PouchDB.Replication.SyncResult<SyncDocument>): Promise<void> {
    // Only process incoming (pull) changes
    if (change.direction !== "pull") return;

    const docs = change.change.docs;

    for (const doc of docs) {
      const path = doc._id;

      // Skip design documents
      if (path.startsWith("_design/")) continue;

      try {
        const parsed = RawSyncDocSchema.safeParse(doc);
        if (!parsed.success) continue;

        const rawDoc = parsed.data;

        if (rawDoc._deleted === true) {
          // Remote deletion
          this.syncing.add(path);
          try {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing !== null) await this.app.vault.adapter.remove(path);
          } finally {
            this.syncing.delete(path);
          }
        } else {
          // Remote create/update — construct a proper SyncDocument from validated data
          const syncDoc: SyncDocument = {
            _id: rawDoc._id,
            content: rawDoc.content ?? "",
            contentType: rawDoc.contentType ?? "text",
            chunks: rawDoc.chunks,
            mtime: rawDoc.mtime ?? 0,
            size: rawDoc.size ?? 0,
            hash: rawDoc.hash ?? "",
            _rev: rawDoc._rev,
            _conflicts: rawDoc._conflicts,
          };
          this.syncing.add(path);
          try {
            await this.writeToVault(syncDoc);
          } finally {
            this.syncing.delete(path);
          }
        }
      } catch (err) {
         
        console.error(`[SyncEngine] Failed to apply remote change for ${path}:`, err);
      }
    }

    // After processing incoming changes, resolve any conflicts
    await this.resolveConflicts();
  }

  // ---------------------------------------------------------------------------
  // Vault I/O
  // ---------------------------------------------------------------------------

  /** Write a SyncDocument to the vault (handles both text and binary) */
  private async writeToVault(doc: SyncDocument): Promise<void> {
    const path = doc._id;

    if (doc.contentType === "text") {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing !== null && existing instanceof TFile) await this.app.vault.modify(existing, doc.content);
      else {
        await ensureParentFolder(this.app, path);
        await this.app.vault.create(path, doc.content);
      }
    } else {
      // Binary file
      let buffer: ArrayBuffer;

      if (doc.chunks !== undefined && doc.chunks.length > 0) {
        // Reassemble from chunks
        const chunkDocs = await this.db.getChunks(doc._id);
        const base64 = reassembleChunks(chunkDocs);
        buffer = base64ToArrayBuffer(base64);
      } else buffer = base64ToArrayBuffer(doc.content);

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing !== null && existing instanceof TFile) await this.app.vault.modifyBinary(existing, buffer);
      else {
        await ensureParentFolder(this.app, path);
        await this.app.vault.createBinary(path, buffer);
      }
    }
  }

  /** Read a vault file and create a SyncDocument */
  private async fileToDoc(file: TFile): Promise<SyncDocument> {
    const path = file.path;

    if (isTextFile(path)) {
      const content = await this.app.vault.read(file);
      const hash = await computeHash(content);

      return {
        _id: path,
        content,
        contentType: "text",
        mtime: file.stat.mtime,
        size: file.stat.size,
        hash,
      };
    }

    // Binary file
    const buffer = await this.app.vault.readBinary(file);
    const hash = await computeHashBinary(buffer);
    const base64 = arrayBufferToBase64(buffer);

    if (file.stat.size > CHUNK_THRESHOLD) {
      // Large binary: split into chunks and store them
      const chunks = splitIntoChunks(path, base64);
      await this.db.bulkPutChunks(chunks);

      return {
        _id: path,
        content: "",
        contentType: "binary",
        chunks: chunks.map((c) => c._id),
        mtime: file.stat.mtime,
        size: file.stat.size,
        hash,
      };
    }

    // Small binary: store inline as base64
    return {
      _id: path,
      content: base64,
      contentType: "binary",
      mtime: file.stat.mtime,
      size: file.stat.size,
      hash,
    };
  }

  // ---------------------------------------------------------------------------
  // Conflict resolution
  // ---------------------------------------------------------------------------

  /** Check for and resolve any conflicts */
  private async resolveConflicts(): Promise<void> {
    let conflicted: SyncDocument[];
    try {
      conflicted = await this.db.getConflicts();
    } catch (err) {
       
      console.error("[SyncEngine] Failed to fetch conflicts:", err);
      return;
    }

    for (const winnerDoc of conflicted) {
      const conflictRevs = winnerDoc._conflicts ?? [];

      for (const rev of conflictRevs)
        try {
          const loserDoc = await this.db.getRevision(winnerDoc._id, rev);
          if (loserDoc === null) continue;

          // Attempt resolution (no ancestor available in MVP)
          const result = resolveConflict(null, winnerDoc, loserDoc);

          // Update the winning doc with resolved content
          const resolved: SyncDocument = {
            ...winnerDoc,
            content: result.winnerContent,
            mtime: Date.now(),
          };
          resolved.hash =
            resolved.contentType === "text"
              ? await computeHash(resolved.content)
              : await computeHashBinary(base64ToArrayBuffer(resolved.content));

          await this.db.put(resolved);

          // Remove the losing revision
          await this.db.removeConflict(winnerDoc._id, rev);

          // If a conflict file is needed, create it in the vault
          if (result.needsConflictFile && result.loserContent !== null) {
            const conflictPath = conflictFilePath(winnerDoc._id);
            try {
              await ensureParentFolder(this.app, conflictPath);
              await this.app.vault.create(conflictPath, result.loserContent);
            } catch (err) {
               
              console.error(`[SyncEngine] Failed to create conflict file ${conflictPath}:`, err);
            }
          }

          // Write resolved content to vault
          this.syncing.add(winnerDoc._id);
          try {
            await this.writeToVault(resolved);
          } finally {
            this.syncing.delete(winnerDoc._id);
          }
        } catch (err) {
           
          console.error(`[SyncEngine] Failed to resolve conflict for ${winnerDoc._id} rev ${rev}:`, err);
        }
    }
  }

  // ---------------------------------------------------------------------------
  // Status management
  // ---------------------------------------------------------------------------

  /** Update the sync status and notify listeners */
  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;

    this.status = status;
    for (const listener of this.statusListeners)
      try {
        listener(status);
      } catch {
        // Don't let a bad listener break the engine
      }
  }
}

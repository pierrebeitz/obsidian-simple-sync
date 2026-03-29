import { type App, TFile, Notice, type EventRef } from "obsidian";
import { SyncDatabase } from "./db";
import { computeHash, computeHashBinary } from "./hasher";
import { splitIntoChunks, reassembleChunks } from "./chunker";
import { resolveConflict } from "./conflict-resolver";
import { RawSyncDocSchema } from "./schemas";
import { type Result, ok, tryAsync, unwrapOr } from "./result";
import { type SyncDocument, type SyncSettings, type SyncStatus, BATCH_SIZE, CHUNK_THRESHOLD, DEBOUNCE_MS } from "./types";

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 8192) {
    const chunk = bytes.subarray(i, Math.min(i + 8192, bytes.byteLength));
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return bytes.buffer;
}

function conflictFilePath(originalPath: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dotIdx = originalPath.lastIndexOf(".");
  if (dotIdx === -1) return `${originalPath}.conflict-${timestamp}`;

  const base = originalPath.slice(0, dotIdx);
  const ext = originalPath.slice(dotIdx);
  return `${base}.conflict-${timestamp}${ext}`;
}

async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  if (parts.length <= 1) return;

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
      // Intentionally ignore errors — folder may have been created concurrently
      await tryAsync(async () => app.vault.createFolder(current));
  }
}

export class SyncEngine {
  private readonly db: SyncDatabase;
  private readonly app: App;
  private readonly settings: SyncSettings;
  private status: SyncStatus = "idle";
  private readonly statusListeners: ((status: SyncStatus, detail?: string) => void)[] = [];

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

  public onStatusChange(listener: (status: SyncStatus, detail?: string) => void): void {
    this.statusListeners.push(listener);
  }

  public async start(): Promise<Result<void>> {
    this.setStatus("initial-sync");
    const result = await this.initialSync();
    if (!result.ok) {
      console.error("[SyncEngine] Failed to start:", result.error);
      this.setStatus("error");
      return result;
    }
    this.startLiveSync();
    this.setStatus("synced");
    return ok(undefined);
  }

  public stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);

    this.debounceTimers.clear();

    for (const ref of this.eventRefs) this.app.vault.offref(ref);

    this.eventRefs = [];

    this.db.stopSync();

    this.setStatus("idle");
  }

  // ---------------------------------------------------------------------------
  // Echo guard
  // ---------------------------------------------------------------------------

  /**
   * Wraps a vault write in echo-prevention guards.
   * Adds the path to the syncing set before the operation and removes it after,
   * so vault event listeners ignore the resulting file-system events.
   */
  private async withEchoGuard(path: string, fn: () => Promise<void>): Promise<Result<void>> {
    this.syncing.add(path);
    const result = await tryAsync(fn);
    this.syncing.delete(path);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Initial sync
  // ---------------------------------------------------------------------------

  private async initialSync(): Promise<Result<void>> {
    const localFiles = this.app.vault.getFiles();
    const remoteResult = await this.db.getAllDocs();
    if (!remoteResult.ok) {
      console.error("[SyncEngine] Failed to fetch remote docs:", remoteResult.error);
      return remoteResult;
    }
    const remoteDocs = remoteResult.value;

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

    const notice = new Notice("Syncing...", 0);
    const reportProgress = (): void => {
      if (total > 0) notice.setMessage(`Syncing ${String(progress)}/${String(total)} files...`);
    };

    // 1. Local-only files -> push to PouchDB in batches
    for (let i = 0; i < localOnly.length; i += BATCH_SIZE) {
      const batch = localOnly.slice(i, i + BATCH_SIZE);
      const docs: SyncDocument[] = [];
      for (const file of batch) {
        const docResult = await tryAsync(async () => this.fileToDoc(file));
        if (docResult.ok) docs.push(docResult.value);
        else console.error(`[SyncEngine] Failed to read local file ${file.path}:`, docResult.error);
      }

      if (docs.length > 0) {
        const bulkResult = await this.db.bulkPut(docs);
        if (!bulkResult.ok) console.error("[SyncEngine] Failed to bulk put docs:", bulkResult.error);
      }

      progress += batch.length;
      reportProgress();
    }

    // 2. Remote-only docs -> write to vault in batches
    for (let i = 0; i < remoteOnly.length; i += BATCH_SIZE) {
      const batch = remoteOnly.slice(i, i + BATCH_SIZE);
      for (const doc of batch) {
        const writeResult = await this.withEchoGuard(doc._id, async () => this.writeToVault(doc));
        if (!writeResult.ok) console.error(`[SyncEngine] Failed to write remote doc ${doc._id}:`, writeResult.error);
      }

      progress += batch.length;
      reportProgress();
    }

    // 3. Files that exist on both sides — compare hashes
    for (let i = 0; i < both.length; i += BATCH_SIZE) {
      const batch = both.slice(i, i + BATCH_SIZE);
      for (const { file, doc } of batch) {
        // Quick mtime check — skip file read if timestamps match
        if (file.stat.mtime === doc.mtime) continue;

        const localDocResult = await tryAsync(async () => this.fileToDoc(file));
        if (!localDocResult.ok) {
          console.error(`[SyncEngine] Failed to reconcile ${file.path}:`, localDocResult.error);
          continue;
        }
        const localDoc = localDocResult.value;

        if (localDoc.hash === doc.hash) continue;

        // Different content: newer mtime wins
        if (localDoc.mtime >= doc.mtime) {
          // Local is newer — push to PouchDB
          if (doc._rev !== undefined) localDoc._rev = doc._rev;

          const putResult = await this.db.put(localDoc);
          if (!putResult.ok) console.error(`[SyncEngine] Failed to put ${file.path}:`, putResult.error);
        } else {
          // Remote is newer — write to vault
          const writeResult = await this.withEchoGuard(doc._id, async () => this.writeToVault(doc));
          if (!writeResult.ok) console.error(`[SyncEngine] Failed to write remote doc ${doc._id}:`, writeResult.error);
        }
      }

      progress += batch.length;
      reportProgress();
    }

    notice.hide();
    if (total > 0) new Notice("Sync complete.");
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Live sync
  // ---------------------------------------------------------------------------

  private startLiveSync(): void {
    this.app.workspace.onLayoutReady(() => {
      const createRef = this.app.vault.on("create", (file) => {
        if (file instanceof TFile && !this.syncing.has(file.path)) this.handleLocalChange(file);
      });
      this.eventRefs.push(createRef);

      const modifyRef = this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && !this.syncing.has(file.path)) this.handleLocalChange(file);
      });
      this.eventRefs.push(modifyRef);

      const deleteRef = this.app.vault.on("delete", (file) => {
        if (!this.syncing.has(file.path))
          this.handleLocalDelete(file.path).catch((e: unknown) => {
            console.error(`[SyncEngine] Failed to handle delete for ${file.path}:`, e);
          });
      });
      this.eventRefs.push(deleteRef);

      const renameRef = this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile)
          this.handleLocalRename(file, oldPath).catch((e: unknown) => {
            console.error(`[SyncEngine] Failed to handle rename for ${file.path}:`, e);
          });
      });
      this.eventRefs.push(renameRef);
    });

    this.db.startSync(
      this.settings,
      (change) => {
        this.handleRemoteChanges(change).catch((e: unknown) => {
          console.error("[SyncEngine] Failed to handle remote changes:", e);
        });
      },
      (e) => {
        console.error("[SyncEngine] Replication error:", e);
        this.setStatus("error", e.message);
      },
      () => {
        if (this.status !== "error") this.setStatus("synced");
      },
      () => {
        this.setStatus("syncing");
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Local change handlers
  // ---------------------------------------------------------------------------

  /** Debounces rapid vault events to avoid redundant syncs */
  private handleLocalChange(file: TFile): void {
    const existing = this.debounceTimers.get(file.path);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      this.processLocalChange(file).catch((e: unknown) => {
        console.error(`[SyncEngine] Failed to process local change for ${file.path}:`, e);
      });
    }, DEBOUNCE_MS);

    this.debounceTimers.set(file.path, timer);
  }

  private async processLocalChange(file: TFile): Promise<void> {
    const docResult = await tryAsync(async () => this.fileToDoc(file));
    if (!docResult.ok) {
      console.error(`[SyncEngine] Failed to read ${file.path}:`, docResult.error);
      return;
    }
    const doc = docResult.value;

    // Check if the content actually changed
    const existing = unwrapOr(await this.db.get(file.path), null);
    if (existing !== null && existing.hash === doc.hash) return;

    // Carry forward the _rev so PouchDB can update
    if (existing?._rev !== undefined) doc._rev = existing._rev;

    const putResult = await this.db.put(doc);
    if (!putResult.ok) console.error(`[SyncEngine] Failed to sync ${file.path}:`, putResult.error);
  }

  private async handleLocalDelete(path: string): Promise<void> {
    const result = await this.db.remove(path);
    if (!result.ok) console.error(`[SyncEngine] Failed to delete ${path}:`, result.error);

    // Clean up any associated chunks
    const chunkResult = await this.db.removeChunks(path);
    if (!chunkResult.ok) console.error(`[SyncEngine] Failed to remove chunks for ${path}:`, chunkResult.error);
  }

  private async handleLocalRename(file: TFile, oldPath: string): Promise<void> {
    const docResult = await tryAsync(async () => this.fileToDoc(file));
    if (!docResult.ok) {
      console.error(`[SyncEngine] Failed to read ${file.path}:`, docResult.error);
      return;
    }

    const putResult = await this.db.put(docResult.value);
    if (!putResult.ok) console.error(`[SyncEngine] Failed to put ${file.path}:`, putResult.error);

    const removeResult = await this.db.remove(oldPath);
    if (!removeResult.ok) console.error(`[SyncEngine] Failed to remove ${oldPath}:`, removeResult.error);

    // Clean up chunks associated with the old path
    const chunkResult = await this.db.removeChunks(oldPath);
    if (!chunkResult.ok) console.error(`[SyncEngine] Failed to remove chunks for ${oldPath}:`, chunkResult.error);
  }

  // ---------------------------------------------------------------------------
  // Remote change handlers
  // ---------------------------------------------------------------------------

  private async handleRemoteChanges(change: PouchDB.Replication.SyncResult<SyncDocument>): Promise<void> {
    if (change.direction !== "pull") return;

    const docs = change.change.docs;

    for (const doc of docs) {
      const path = doc._id;

      if (path.startsWith("_design/")) continue;

      const parsed = RawSyncDocSchema.safeParse(doc);
      if (!parsed.success) continue;

      const rawDoc = parsed.data;

      if (rawDoc._deleted === true) {
        const deleteResult = await this.withEchoGuard(path, async () => {
          const existingFile = this.app.vault.getAbstractFileByPath(path);
          if (existingFile !== null) await this.app.vault.adapter.remove(path);
        });
        if (!deleteResult.ok) console.error(`[SyncEngine] Failed to delete remote file ${path}:`, deleteResult.error);

        // Clean up any associated chunks
        const chunkResult = await this.db.removeChunks(path);
        if (!chunkResult.ok) console.error(`[SyncEngine] Failed to remove chunks for ${path}:`, chunkResult.error);
      } else {
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
        const writeResult = await this.withEchoGuard(path, async () => this.writeToVault(syncDoc));
        if (!writeResult.ok) console.error(`[SyncEngine] Failed to apply remote change for ${path}:`, writeResult.error);
      }
    }

    await this.resolveConflicts();
  }

  // ---------------------------------------------------------------------------
  // Vault I/O
  // ---------------------------------------------------------------------------

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
      let buffer: ArrayBuffer;

      if (doc.chunks !== undefined && doc.chunks.length > 0) {
        const chunkResult = await this.db.getChunks(doc._id);
        const chunkDocs = unwrapOr(chunkResult, []);
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
      // Clean up old chunks before writing new ones
      const removeResult = await this.db.removeChunks(path);
      if (!removeResult.ok) console.error(`[SyncEngine] Failed to remove old chunks for ${path}:`, removeResult.error);

      const chunks = splitIntoChunks(path, base64);
      const bulkResult = await this.db.bulkPutChunks(chunks);
      if (!bulkResult.ok) console.error(`[SyncEngine] Failed to store chunks for ${path}:`, bulkResult.error);

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

  private async resolveConflicts(): Promise<void> {
    const conflictResult = await this.db.getConflicts();
    if (!conflictResult.ok) {
      console.error("[SyncEngine] Failed to fetch conflicts:", conflictResult.error);
      return;
    }

    for (const winnerDoc of conflictResult.value) {
      const conflictRevs = winnerDoc._conflicts ?? [];

      for (const rev of conflictRevs) {
        const loserResult = await this.db.getRevision(winnerDoc._id, rev);
        if (!loserResult.ok) {
          console.error(`[SyncEngine] Failed to get revision ${rev} for ${winnerDoc._id}:`, loserResult.error);
          continue;
        }
        const loserDoc = loserResult.value;
        if (loserDoc === null) continue;

        // Try to find the common ancestor for three-way merge
        let ancestor: SyncDocument | null = null;

        const winnerRevs = await this.db.getWithRevisions(winnerDoc._id);
        const loserRevs = await this.db.getWithRevisions(winnerDoc._id, rev);

        if (winnerRevs.ok && winnerRevs.value !== null && loserRevs.ok && loserRevs.value !== null) {
          const winnerSet = new Set(winnerRevs.value.revisions);
          const commonRev = loserRevs.value.revisions.find((r) => winnerSet.has(r));

          if (commonRev !== undefined) {
            const ancestorResult = await this.db.getRevision(winnerDoc._id, commonRev);
            ancestor = unwrapOr(ancestorResult, null);
          }
        }

        const resolution = resolveConflict(ancestor, winnerDoc, loserDoc);

        const resolved: SyncDocument = {
          ...winnerDoc,
          content: resolution.winnerContent,
          mtime: Date.now(),
        };
        resolved.hash =
          resolved.contentType === "text"
            ? await computeHash(resolved.content)
            : await computeHashBinary(base64ToArrayBuffer(resolved.content));

        const putResult = await this.db.put(resolved);
        if (!putResult.ok) {
          console.error(`[SyncEngine] Failed to put resolved doc ${winnerDoc._id}:`, putResult.error);
          continue;
        }

        const removeResult = await this.db.removeConflict(winnerDoc._id, rev);
        if (!removeResult.ok) console.error(`[SyncEngine] Failed to remove conflict rev ${rev} for ${winnerDoc._id}:`, removeResult.error);

        if (resolution.needsConflictFile && resolution.loserContent !== null) {
          const cPath = conflictFilePath(winnerDoc._id);
          const createResult = await tryAsync(async () => {
            await ensureParentFolder(this.app, cPath);
            await this.app.vault.create(cPath, resolution.loserContent ?? "");
          });
          if (createResult.ok) new Notice(`Conflict resolved: ${winnerDoc._id}\nSaved alternate version as ${cPath.split("/").pop() ?? cPath}`);
          else console.error(`[SyncEngine] Failed to create conflict file ${cPath}:`, createResult.error);
        }

        // Write resolved content to vault
        const writeResult = await this.withEchoGuard(winnerDoc._id, async () => this.writeToVault(resolved));
        if (!writeResult.ok) console.error(`[SyncEngine] Failed to write resolved doc ${winnerDoc._id}:`, writeResult.error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status management
  // ---------------------------------------------------------------------------

  private setStatus(status: SyncStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;

    this.status = status;
    for (const listener of this.statusListeners)
      try {
        listener(status, detail);
      } catch {
        // Don't let a bad listener break the engine
      }
  }
}

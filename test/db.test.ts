import { describe, it, expect, afterEach } from "vitest";
import { SyncDatabase } from "../src/db";
import type { SyncDocument, ChunkDocument } from "../src/types";

/** Generate a unique DB name to isolate each test */
function uniqueDbName(): string {
  return `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeDoc(overrides: Partial<SyncDocument> & { _id: string }): SyncDocument {
  return {
    content: "hello world",
    contentType: "text",
    mtime: Date.now(),
    size: 11,
    hash: "abc123",
    ...overrides,
  };
}

describe("SyncDatabase", () => {
  const dbs: SyncDatabase[] = [];

  /** Track databases so we can clean them up after each test */
  function createDb(): SyncDatabase {
    const db = new SyncDatabase(uniqueDbName());
    dbs.push(db);
    return db;
  }

  afterEach(async () => {
    for (const db of dbs) {
      try {
        await db.destroy();
      } catch {
        // already destroyed — ignore
      }
    }
    dbs.length = 0;
  });

  // ---------------------------------------------------------------
  // 1. put and get
  // ---------------------------------------------------------------
  it("put and get: stores and retrieves a document", async () => {
    const db = createDb();
    const doc = makeDoc({ _id: "notes/hello.md" });

    await db.put(doc);
    const retrieved = await db.get("notes/hello.md");

    expect(retrieved).not.toBeNull();
    expect(retrieved!._id).toBe("notes/hello.md");
    expect(retrieved!.content).toBe("hello world");
    expect(retrieved!.hash).toBe("abc123");
    expect(retrieved!._rev).toBeDefined();
  });

  // ---------------------------------------------------------------
  // 2. put handles 409 conflict via auto-retry
  // ---------------------------------------------------------------
  it("put handles 409 conflict by fetching latest rev", async () => {
    const db = createDb();
    const doc = makeDoc({ _id: "conflict-test.md" });

    // Initial put — this gives doc._rev a value
    await db.put(doc);
    const first = await db.get("conflict-test.md");
    expect(first).not.toBeNull();

    // Simulate a stale rev: put again with the original (now-outdated) rev
    // The class should detect the 409 and retry with the current rev
    const staleDoc = makeDoc({
      _id: "conflict-test.md",
      content: "updated content",
      _rev: first!._rev,
    } as any);

    // Externally update the doc so the rev we have becomes stale
    const freshDoc = makeDoc({
      _id: "conflict-test.md",
      content: "external update",
      _rev: first!._rev,
    } as any);
    await db.put(freshDoc);

    // Now staleDoc's _rev is outdated — put should handle the 409
    const staleDoc2 = makeDoc({
      _id: "conflict-test.md",
      content: "final content",
      _rev: first!._rev,
    } as any);
    await db.put(staleDoc2);

    const final = await db.get("conflict-test.md");
    expect(final!.content).toBe("final content");
  });

  // ---------------------------------------------------------------
  // 3. get returns null for missing doc
  // ---------------------------------------------------------------
  it("get returns null when document does not exist", async () => {
    const db = createDb();
    const result = await db.get("does-not-exist.md");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------
  // 4. remove deletes a document
  // ---------------------------------------------------------------
  it("remove: deletes a document so get returns null", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "to-delete.md" }));

    await db.remove("to-delete.md");
    const result = await db.get("to-delete.md");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------
  // 5. remove non-existent doc does not throw
  // ---------------------------------------------------------------
  it("remove: does not throw for a non-existent document", async () => {
    const db = createDb();
    await expect(db.remove("ghost.md")).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------
  // 6. bulkPut and getAllDocs
  // ---------------------------------------------------------------
  it("bulkPut and getAllDocs: inserts many docs and retrieves them", async () => {
    const db = createDb();
    const docs = Array.from({ length: 5 }, (_, i) => makeDoc({ _id: `bulk/doc-${i}.md`, content: `content ${i}` }));

    await db.bulkPut(docs);
    const all = await db.getAllDocs();

    expect(all).toHaveLength(5);
    const ids = all.map((d) => d._id).sort();
    expect(ids).toEqual(["bulk/doc-0.md", "bulk/doc-1.md", "bulk/doc-2.md", "bulk/doc-3.md", "bulk/doc-4.md"]);
  });

  // ---------------------------------------------------------------
  // 7. getAllDocs excludes _design/ documents
  // ---------------------------------------------------------------
  it("getAllDocs excludes _design/ documents", async () => {
    const db = createDb();

    // Insert a regular doc and a design doc
    await db.put(makeDoc({ _id: "real-doc.md" }));

    // Design docs need to be inserted at a lower level.
    // We use bulkPut which delegates to bulkDocs — PouchDB allows
    // _design/ docs via bulkDocs.
    await db.bulkPut([makeDoc({ _id: "_design/my-view" })]);

    const all = await db.getAllDocs();
    expect(all).toHaveLength(1);
    expect(all[0]._id).toBe("real-doc.md");
  });

  // ---------------------------------------------------------------
  // 8. putChunk and getChunks
  // ---------------------------------------------------------------
  it("putChunk and getChunks: stores and retrieves chunks by parent ID", async () => {
    const db = createDb();
    const parentId = "large-file.bin";

    const chunks: ChunkDocument[] = [
      { _id: `chunk:${parentId}:000`, data: "AAAA" },
      { _id: `chunk:${parentId}:001`, data: "BBBB" },
      { _id: `chunk:${parentId}:002`, data: "CCCC" },
    ];

    for (const chunk of chunks) {
      await db.putChunk(chunk);
    }

    const retrieved = await db.getChunks(parentId);
    expect(retrieved).toHaveLength(3);

    const datas = retrieved.map((c) => c.data);
    expect(datas).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  // ---------------------------------------------------------------
  // 9. bulkPutChunks
  // ---------------------------------------------------------------
  it("bulkPutChunks: inserts multiple chunks at once", async () => {
    const db = createDb();
    const parentId = "another-file.bin";

    const chunks: ChunkDocument[] = Array.from({ length: 4 }, (_, i) => ({
      _id: `chunk:${parentId}:${String(i).padStart(3, "0")}`,
      data: `data-${i}`,
    }));

    await db.bulkPutChunks(chunks);

    const retrieved = await db.getChunks(parentId);
    expect(retrieved).toHaveLength(4);
    expect(retrieved[0].data).toBe("data-0");
    expect(retrieved[3].data).toBe("data-3");
  });

  // ---------------------------------------------------------------
  // 10. getChunks returns empty array when no chunks exist
  // ---------------------------------------------------------------
  it("getChunks returns empty array for non-existent parent", async () => {
    const db = createDb();
    const result = await db.getChunks("no-such-parent");
    expect(result).toEqual([]);
  });

  // ---------------------------------------------------------------
  // 11. putChunk handles 409 conflict (update existing chunk)
  // ---------------------------------------------------------------
  it("putChunk handles conflict when updating an existing chunk", async () => {
    const db = createDb();
    const chunk: ChunkDocument = { _id: "chunk:file.bin:000", data: "original" };

    await db.putChunk(chunk);

    // Put again without _rev — should trigger 409 path and succeed
    const updated: ChunkDocument = { _id: "chunk:file.bin:000", data: "updated" };
    await db.putChunk(updated);

    const chunks = await db.getChunks("file.bin");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].data).toBe("updated");
  });

  // ---------------------------------------------------------------
  // 12. destroy makes the database unusable
  // ---------------------------------------------------------------
  it("destroy: makes the database inaccessible", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "soon-gone.md" }));

    await db.destroy();

    // After destroy, any operation should fail
    await expect(db.get("soon-gone.md")).rejects.toThrow();

    // Remove from cleanup list since we already destroyed it
    const idx = dbs.indexOf(db);
    if (idx !== -1) dbs.splice(idx, 1);
  });

  // ---------------------------------------------------------------
  // 13. put updates an existing document
  // ---------------------------------------------------------------
  it("put: updates an existing document when _rev is provided", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "update-me.md", content: "v1" }));

    const v1 = await db.get("update-me.md");
    expect(v1!.content).toBe("v1");

    await db.put(makeDoc({ _id: "update-me.md", content: "v2", _rev: v1!._rev } as any));
    const v2 = await db.get("update-me.md");
    expect(v2!.content).toBe("v2");
    expect(v2!._rev).not.toBe(v1!._rev);
  });
});

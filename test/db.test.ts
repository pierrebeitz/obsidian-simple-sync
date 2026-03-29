import { describe, it, expect, afterEach } from "vitest";
import { SyncDatabase } from "../src/db";
import type { SyncDocument, ChunkDocument } from "../src/types";

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

  function createDb(): SyncDatabase {
    const db = new SyncDatabase(uniqueDbName());
    dbs.push(db);
    return db;
  }

  afterEach(async () => {
    for (const db of dbs) {
      await db.destroy();
    }
    dbs.length = 0;
  });

  it("put and get: stores and retrieves a document", async () => {
    const db = createDb();
    const doc = makeDoc({ _id: "notes/hello.md" });

    const putResult = await db.put(doc);
    expect(putResult.ok).toBe(true);

    const getResult = await db.get("notes/hello.md");
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).not.toBeNull();
    expect(getResult.value?._id).toBe("notes/hello.md");
    expect(getResult.value?.content).toBe("hello world");
    expect(getResult.value?.hash).toBe("abc123");
    expect(getResult.value?._rev).toBeDefined();
  });

  it("put handles 409 conflict by fetching latest rev", async () => {
    const db = createDb();
    const doc = makeDoc({ _id: "conflict-test.md" });

    await db.put(doc);
    const first = await db.get("conflict-test.md");
    expect(first.ok).toBe(true);
    if (!first.ok || first.value === null) return;

    // Update to get a new rev
    await db.put(makeDoc({ _id: "conflict-test.md", content: "external update", _rev: first.value._rev }));

    // Now put with the stale rev — should handle 409 internally
    await db.put(makeDoc({ _id: "conflict-test.md", content: "final content", _rev: first.value._rev }));

    const final = await db.get("conflict-test.md");
    expect(final.ok).toBe(true);
    if (!final.ok || final.value === null) return;
    expect(final.value.content).toBe("final content");
  });

  it("get returns ok(null) when document does not exist", async () => {
    const db = createDb();
    const result = await db.get("does-not-exist.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("remove: deletes a document so get returns null", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "to-delete.md" }));

    const removeResult = await db.remove("to-delete.md");
    expect(removeResult.ok).toBe(true);

    const getResult = await db.get("to-delete.md");
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toBeNull();
  });

  it("remove: returns ok for a non-existent document", async () => {
    const db = createDb();
    const result = await db.remove("ghost.md");
    expect(result.ok).toBe(true);
  });

  it("bulkPut and getAllDocs: inserts many docs and retrieves them", async () => {
    const db = createDb();
    const docs = Array.from({ length: 5 }, (_, i) => makeDoc({ _id: `bulk/doc-${i}.md`, content: `content ${i}` }));

    const bulkResult = await db.bulkPut(docs);
    expect(bulkResult.ok).toBe(true);

    const allResult = await db.getAllDocs();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;

    expect(allResult.value).toHaveLength(5);
    const ids = allResult.value.map((d) => d._id).sort();
    expect(ids).toEqual(["bulk/doc-0.md", "bulk/doc-1.md", "bulk/doc-2.md", "bulk/doc-3.md", "bulk/doc-4.md"]);
  });

  it("getAllDocs excludes _design/ documents", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "real-doc.md" }));
    await db.bulkPut([makeDoc({ _id: "_design/my-view" })]);

    const allResult = await db.getAllDocs();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;

    expect(allResult.value).toHaveLength(1);
    expect(allResult.value[0]._id).toBe("real-doc.md");
  });

  it("putChunk and getChunks: stores and retrieves chunks by parent ID", async () => {
    const db = createDb();
    const parentId = "large-file.bin";

    const chunks: ChunkDocument[] = [
      { _id: `chunk:${parentId}:000`, data: "AAAA" },
      { _id: `chunk:${parentId}:001`, data: "BBBB" },
      { _id: `chunk:${parentId}:002`, data: "CCCC" },
    ];

    for (const chunk of chunks) {
      const r = await db.putChunk(chunk);
      expect(r.ok).toBe(true);
    }

    const getResult = await db.getChunks(parentId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).toHaveLength(3);
    expect(getResult.value.map((c) => c.data)).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("bulkPutChunks: inserts multiple chunks at once", async () => {
    const db = createDb();
    const parentId = "another-file.bin";

    const chunks: ChunkDocument[] = Array.from({ length: 4 }, (_, i) => ({
      _id: `chunk:${parentId}:${String(i).padStart(3, "0")}`,
      data: `data-${i}`,
    }));

    const bulkResult = await db.bulkPutChunks(chunks);
    expect(bulkResult.ok).toBe(true);

    const getResult = await db.getChunks(parentId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).toHaveLength(4);
    expect(getResult.value[0].data).toBe("data-0");
    expect(getResult.value[3].data).toBe("data-3");
  });

  it("getChunks returns ok(empty array) for non-existent parent", async () => {
    const db = createDb();
    const result = await db.getChunks("no-such-parent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("putChunk handles conflict when updating an existing chunk", async () => {
    const db = createDb();
    const chunk: ChunkDocument = { _id: "chunk:file.bin:000", data: "original" };
    await db.putChunk(chunk);

    const updated: ChunkDocument = { _id: "chunk:file.bin:000", data: "updated" };
    const r = await db.putChunk(updated);
    expect(r.ok).toBe(true);

    const getResult = await db.getChunks("file.bin");
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).toHaveLength(1);
    expect(getResult.value[0].data).toBe("updated");
  });

  it("destroy: returns ok and makes subsequent operations fail", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "soon-gone.md" }));

    const destroyResult = await db.destroy();
    expect(destroyResult.ok).toBe(true);

    // After destroy, get returns an error Result
    const getResult = await db.get("soon-gone.md");
    expect(getResult.ok).toBe(false);

    // Remove from cleanup list
    const idx = dbs.indexOf(db);
    if (idx !== -1) dbs.splice(idx, 1);
  });

  it("put: updates an existing document when _rev is provided", async () => {
    const db = createDb();
    await db.put(makeDoc({ _id: "update-me.md", content: "v1" }));

    const v1Result = await db.get("update-me.md");
    expect(v1Result.ok).toBe(true);
    if (!v1Result.ok || v1Result.value === null) return;
    expect(v1Result.value.content).toBe("v1");

    await db.put(makeDoc({ _id: "update-me.md", content: "v2", _rev: v1Result.value._rev }));

    const v2Result = await db.get("update-me.md");
    expect(v2Result.ok).toBe(true);
    if (!v2Result.ok || v2Result.value === null) return;
    expect(v2Result.value.content).toBe("v2");
    expect(v2Result.value._rev).not.toBe(v1Result.value._rev);
  });
});

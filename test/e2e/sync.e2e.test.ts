/**
 * End-to-end tests: PouchDB ↔ CouchDB replication.
 *
 * These tests spin up a real CouchDB container via Docker and verify
 * the full sync pipeline: local writes replicate to remote, remote
 * writes replicate to local, and conflicts are detected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import PouchDB from "pouchdb-core";
import AdapterMemory from "pouchdb-adapter-memory";
import HttpAdapter from "pouchdb-adapter-http";
import Replication from "pouchdb-replication";
import Mapreduce from "pouchdb-mapreduce";
import { startCouchDB, stopCouchDB, type CouchDBContext } from "./setup";
import { computeHash } from "../../src/hasher";
import { splitIntoChunks, reassembleChunks } from "../../src/chunker";
import { threeWayMerge } from "../../src/conflict-resolver";
import type { SyncDocument, ChunkDocument } from "../../src/types";

// Assemble PouchDB with required plugins
PouchDB.plugin(AdapterMemory);
PouchDB.plugin(HttpAdapter);
PouchDB.plugin(Replication);
PouchDB.plugin(Mapreduce);

let ctx: CouchDBContext;
let localDb: PouchDB.Database<SyncDocument>;
let remoteDb: PouchDB.Database<SyncDocument>;
let testCounter = 0;

function uniqueDbName(): string {
  testCounter++;
  return `e2e-local-${Date.now()}-${testCounter}`;
}

function waitForReplication<T>(db: PouchDB.Database<T>, docId: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      db.get(docId)
        .then(() => {
          clearInterval(poll);
          resolve();
        })
        .catch(() => {
          if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error(`Timed out waiting for doc ${docId} to replicate`));
          }
        });
    }, 200);
  });
}

describe("E2E: PouchDB ↔ CouchDB", () => {
  beforeAll(async () => {
    ctx = await startCouchDB();
  }, 60_000);

  afterAll(async () => {
    await stopCouchDB();
  }, 30_000);

  beforeEach(async () => {
    // Fresh local DB per test
    const name = uniqueDbName();
    localDb = new PouchDB<SyncDocument>(name, { adapter: "memory" });

    // Fresh remote DB per test (new DB on the CouchDB server)
    const remoteDbName = `test-${Date.now()}-${testCounter}`;
    const remoteUrl = `${ctx.url}/${remoteDbName}`;

    // Create the remote database
    const resp = await fetch(`${remoteUrl}`, {
      method: "PUT",
      headers: { Authorization: "Basic " + btoa(`${ctx.username}:${ctx.password}`) },
    });
    if (!resp.ok && resp.status !== 412) {
      throw new Error(`Failed to create remote DB: ${resp.status}`);
    }

    remoteDb = new PouchDB<SyncDocument>(remoteUrl, {
      auth: { username: ctx.username, password: ctx.password },
    });
  });

  it("replicates a local document to CouchDB", async () => {
    const doc: SyncDocument = {
      _id: "notes/hello.md",
      content: "# Hello World",
      contentType: "text",
      mtime: Date.now(),
      size: 13,
      hash: await computeHash("# Hello World"),
    };

    await localDb.put(doc);

    // One-shot push replication
    await localDb.replicate.to(remoteDb);

    // Verify it arrived
    const remote = await remoteDb.get("notes/hello.md");
    expect(remote.content).toBe("# Hello World");
    expect(remote.hash).toBe(doc.hash);
  });

  it("replicates a remote document to local", async () => {
    const doc: SyncDocument = {
      _id: "notes/from-remote.md",
      content: "Written on another device",
      contentType: "text",
      mtime: Date.now(),
      size: 25,
      hash: await computeHash("Written on another device"),
    };

    await remoteDb.put(doc);

    // One-shot pull replication
    await localDb.replicate.from(remoteDb);

    const local = await localDb.get("notes/from-remote.md");
    expect(local.content).toBe("Written on another device");
  });

  it("bidirectional sync exchanges documents", async () => {
    const docA: SyncDocument = {
      _id: "a.md",
      content: "from local",
      contentType: "text",
      mtime: Date.now(),
      size: 10,
      hash: await computeHash("from local"),
    };

    const docB: SyncDocument = {
      _id: "b.md",
      content: "from remote",
      contentType: "text",
      mtime: Date.now(),
      size: 11,
      hash: await computeHash("from remote"),
    };

    await localDb.put(docA);
    await remoteDb.put(docB);

    // Bidirectional sync
    await localDb.sync(remoteDb);

    // Both sides should have both docs
    const localA = await localDb.get("a.md");
    const localB = await localDb.get("b.md");
    const remoteA = await remoteDb.get("a.md");
    const remoteB = await remoteDb.get("b.md");

    expect(localA.content).toBe("from local");
    expect(localB.content).toBe("from remote");
    expect(remoteA.content).toBe("from local");
    expect(remoteB.content).toBe("from remote");
  });

  it("detects conflicts from concurrent edits", async () => {
    // Seed a document on both sides
    const original: SyncDocument = {
      _id: "shared.md",
      content: "original content",
      contentType: "text",
      mtime: 1000,
      size: 16,
      hash: await computeHash("original content"),
    };

    await localDb.put(original);
    await localDb.replicate.to(remoteDb);

    // Edit on both sides independently
    const localVersion = await localDb.get("shared.md");
    const remoteVersion = await remoteDb.get("shared.md");

    await localDb.put({
      ...localVersion,
      content: "edited locally",
      hash: await computeHash("edited locally"),
      mtime: 2000,
    });

    await remoteDb.put({
      ...remoteVersion,
      content: "edited remotely",
      hash: await computeHash("edited remotely"),
      mtime: 3000,
    });

    // Sync — this should create a conflict
    await localDb.sync(remoteDb);

    // Check for conflicts
    const doc = await localDb.get("shared.md", { conflicts: true });
    expect(doc._conflicts).toBeDefined();
    expect(doc._conflicts!.length).toBeGreaterThan(0);
  });

  it("conflict resolution via three-way merge produces clean result", async () => {
    // This tests our merge logic end-to-end with data that went through CouchDB
    const ancestor = "line 1\nline 2\nline 3\nline 4\nline 5";
    const versionA = "line 1 edited\nline 2\nline 3\nline 4\nline 5";
    const versionB = "line 1\nline 2\nline 3\nline 4\nline 5 edited";

    // Seed ancestor
    const ancestorDoc: SyncDocument = {
      _id: "merge-test.md",
      content: ancestor,
      contentType: "text",
      mtime: 1000,
      size: ancestor.length,
      hash: await computeHash(ancestor),
    };
    await localDb.put(ancestorDoc);
    await localDb.replicate.to(remoteDb);

    // Edit both sides
    const localVersion = await localDb.get("merge-test.md");
    const remoteVersion = await remoteDb.get("merge-test.md");

    await localDb.put({
      ...localVersion,
      content: versionA,
      hash: await computeHash(versionA),
      mtime: 2000,
    });
    await remoteDb.put({
      ...remoteVersion,
      content: versionB,
      hash: await computeHash(versionB),
      mtime: 2000,
    });

    // Sync to create conflict
    await localDb.sync(remoteDb);

    // Fetch winner + loser
    const winner = await localDb.get("merge-test.md", { conflicts: true });
    const loserRev = winner._conflicts![0];
    const loser = await localDb.get("merge-test.md", { rev: loserRev });

    // Run our three-way merge
    const result = threeWayMerge(ancestor, winner.content, loser.content);
    expect(result.clean).toBe(true);
    expect(result.merged).toContain("line 1 edited");
    expect(result.merged).toContain("line 5 edited");
  });

  it("replicates chunked binary files", async () => {
    // Create a fake "binary" file as base64
    const binaryData = Buffer.from("x".repeat(2_000_000)).toString("base64");
    const chunks = splitIntoChunks("image.png", binaryData);

    // Store chunks in local DB
    const chunkDb = new PouchDB<ChunkDocument>(localDb.name, { adapter: "memory" });
    for (const chunk of chunks) {
      await chunkDb.put(chunk);
    }

    // Store the parent doc
    const doc: SyncDocument = {
      _id: "image.png",
      content: "",
      contentType: "binary",
      chunks: chunks.map((c) => c._id),
      mtime: Date.now(),
      size: 2_000_000,
      hash: "fakehash",
    };
    await localDb.put(doc);

    // Replicate everything to remote
    await localDb.replicate.to(remoteDb);

    // Verify parent doc arrived
    const remoteDoc = await remoteDb.get("image.png");
    expect(remoteDoc.contentType).toBe("binary");
    expect(remoteDoc.chunks).toBeDefined();
    expect(remoteDoc.chunks!.length).toBe(chunks.length);

    // Verify chunks arrived (using remote DB with chunk typing)
    const remoteChunkDb = new PouchDB<ChunkDocument>(remoteDb.name, {
      auth: { username: ctx.username, password: ctx.password },
    });
    const allRemoteChunks = await remoteChunkDb.allDocs({
      include_docs: true,
      startkey: "chunk:image.png:",
      endkey: "chunk:image.png:\uffff",
    });

    const remoteDocs = allRemoteChunks.rows.filter((r) => r.doc !== undefined).map((r) => r.doc!);
    expect(remoteDocs.length).toBe(chunks.length);

    // Reassemble and verify
    const reassembled = reassembleChunks(remoteDocs);
    expect(reassembled).toBe(binaryData);
  });

  it("live replication propagates changes in near-real-time", async () => {
    // Start live bidirectional sync
    const sync = localDb.sync(remoteDb, { live: true, retry: true });

    try {
      // Write locally
      const doc: SyncDocument = {
        _id: "live-test.md",
        content: "live update",
        contentType: "text",
        mtime: Date.now(),
        size: 11,
        hash: await computeHash("live update"),
      };
      await localDb.put(doc);

      // Wait for it to appear on remote
      await waitForReplication(remoteDb, "live-test.md", 10_000);

      const remote = await remoteDb.get("live-test.md");
      expect(remote.content).toBe("live update");

      // Write on remote, verify it arrives locally
      const doc2: SyncDocument = {
        _id: "live-remote.md",
        content: "from CouchDB",
        contentType: "text",
        mtime: Date.now(),
        size: 12,
        hash: await computeHash("from CouchDB"),
      };
      await remoteDb.put(doc2);

      await waitForReplication(localDb, "live-remote.md", 10_000);

      const local = await localDb.get("live-remote.md");
      expect(local.content).toBe("from CouchDB");
    } finally {
      sync.cancel();
    }
  }, 30_000);

  it("handles document deletion across sync", async () => {
    const doc: SyncDocument = {
      _id: "to-delete.md",
      content: "delete me",
      contentType: "text",
      mtime: Date.now(),
      size: 9,
      hash: await computeHash("delete me"),
    };

    await localDb.put(doc);
    await localDb.replicate.to(remoteDb);

    // Verify it exists on remote
    const remote = await remoteDb.get("to-delete.md");
    expect(remote.content).toBe("delete me");

    // Delete locally
    const toDelete = await localDb.get("to-delete.md");
    await localDb.remove(toDelete);

    // Replicate deletion
    await localDb.replicate.to(remoteDb);

    // Verify it's gone on remote
    try {
      await remoteDb.get("to-delete.md");
      expect.fail("Document should have been deleted");
    } catch (err: unknown) {
      const e = err as { status?: number };
      expect(e.status).toBe(404);
    }
  });

  it("handles many documents in bulk sync", async () => {
    const docs: SyncDocument[] = [];
    for (let i = 0; i < 100; i++) {
      docs.push({
        _id: `bulk/note-${String(i).padStart(3, "0")}.md`,
        content: `Note number ${i}`,
        contentType: "text",
        mtime: Date.now(),
        size: 14,
        hash: await computeHash(`Note number ${i}`),
      });
    }

    await localDb.bulkDocs(docs);
    await localDb.replicate.to(remoteDb);

    const remoteResult = await remoteDb.allDocs();
    // CouchDB may include design docs, filter them out
    const syncedDocs = remoteResult.rows.filter((r) => !r.id.startsWith("_design/"));
    expect(syncedDocs.length).toBe(100);
  });
});

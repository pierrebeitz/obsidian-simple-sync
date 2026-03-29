import { type ChunkDocument, CHUNK_SIZE } from "./types";

/** Generate the chunk ID for a given parent and index */
export function chunkId(parentId: string, index: number): string {
  return `chunk:${parentId}:${String(index).padStart(6, "0")}`;
}

/** Split a base64-encoded string into chunk documents */
export function splitIntoChunks(
  parentId: string,
  base64Data: string,
): ChunkDocument[] {
  const chunks: ChunkDocument[] = [];
  for (let i = 0; i < base64Data.length; i += CHUNK_SIZE) {
    const data = base64Data.slice(i, i + CHUNK_SIZE);
    chunks.push({
      _id: chunkId(parentId, chunks.length),
      data,
    });
  }
  return chunks;
}

/** Reassemble chunk documents back into a single base64 string.
 *  Chunks must be passed in order (sorted by _id). */
export function reassembleChunks(chunks: ChunkDocument[]): string {
  const sorted = [...chunks].sort((a, b) => a._id.localeCompare(b._id));
  return sorted.map((c) => c.data).join("");
}

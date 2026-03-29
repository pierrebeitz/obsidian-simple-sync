import { z } from "zod";

/** Schema for validating PouchDB error objects */
export const PouchDBErrorSchema = z.object({
  status: z.number(),
  message: z.string().optional(),
  name: z.string().optional(),
});

/** Extract a status code from an unknown PouchDB error. Returns -1 if unrecognized. */
export function getPouchDBErrorStatus(err: unknown): number {
  const parsed = PouchDBErrorSchema.safeParse(err);
  if (parsed.success) return parsed.data.status;

  return -1;
}

/** Schema for validating a replication change event direction */
export const ReplicationChangeSchema = z.object({
  direction: z.enum(["push", "pull"]),
  change: z.object({
    docs: z.array(z.record(z.string(), z.unknown())),
  }),
});

/** Type derived from the replication change schema */
export type ReplicationChange = z.infer<typeof ReplicationChangeSchema>;

/** Safely parse a replication change event. Returns null if invalid. */
export function parseReplicationChange(raw: unknown): ReplicationChange | null {
  const parsed = ReplicationChangeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  return null;
}

/** Schema for validating a raw document from PouchDB that might be a SyncDocument */
export const RawSyncDocSchema = z.object({
  _id: z.string(),
  _rev: z.string().optional(),
  _deleted: z.boolean().optional(),
  _conflicts: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentType: z.enum(["text", "binary"]).optional(),
  chunks: z.array(z.string()).optional(),
  mtime: z.number().optional(),
  size: z.number().optional(),
  hash: z.string().optional(),
});

export type RawSyncDoc = z.infer<typeof RawSyncDocSchema>;

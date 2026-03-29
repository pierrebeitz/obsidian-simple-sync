import DiffMatchPatch from "diff-match-patch";
import type { SyncDocument } from "./types";

export interface MergeResult {
  merged: string;
  clean: boolean;
}

export interface ResolvedConflict {
  winnerContent: string;
  loserContent: string | null;
  needsConflictFile: boolean;
}

/**
 * Three-way merge: given a common ancestor and two divergent versions,
 * produce a merged result.
 *
 * Strategy:
 * 1. Compute patches from ancestor -> versionB
 * 2. Apply those patches onto versionA
 * 3. If all patches apply cleanly, the merge is clean
 * 4. If some patches fail, the merge is dirty but still our best attempt
 */
export function threeWayMerge(ancestor: string, versionA: string, versionB: string): MergeResult {
  const dmp = new DiffMatchPatch();

  const diffs = dmp.diff_main(ancestor, versionB);
  dmp.diff_cleanupSemantic(diffs);

  const patches = dmp.patch_make(ancestor, diffs);
  const [merged, results] = dmp.patch_apply(patches, versionA);

  const clean = results.every((applied) => applied);

  return { merged, clean };
}

/**
 * Resolve a conflict between two SyncDocument versions.
 *
 * For text files:
 * - If we have an ancestor, attempt three-way merge
 * - If merge is clean, return merged content with no conflict file
 * - If merge is dirty, return merged content and mark the loser for a conflict file
 * - If no ancestor, newer mtime wins; older becomes the conflict file
 *
 * For binary files:
 * - Always return newer version by mtime, no conflict file
 */
export function resolveConflict(ancestor: SyncDocument | null, versionA: SyncDocument, versionB: SyncDocument): ResolvedConflict {
  // Binary files: newer wins, no merge possible
  if (versionA.contentType === "binary" || versionB.contentType === "binary") {
    const newer = versionA.mtime >= versionB.mtime ? versionA : versionB;
    return {
      winnerContent: newer.content,
      loserContent: null,
      needsConflictFile: false,
    };
  }

  // Text files with ancestor: attempt three-way merge
  if (ancestor !== null) {
    const { merged, clean } = threeWayMerge(ancestor.content, versionA.content, versionB.content);

    if (clean)
      return {
        winnerContent: merged,
        loserContent: null,
        needsConflictFile: false,
      };

    // Dirty merge: keep merged as winner, loser is the version that wasn't
    // used as the base for patching (versionB, since we patched onto versionA)
    return {
      winnerContent: merged,
      loserContent: versionB.content,
      needsConflictFile: true,
    };
  }

  // Text files without ancestor: newer mtime wins, older becomes conflict file
  const [newer, older] = versionA.mtime >= versionB.mtime ? [versionA, versionB] : [versionB, versionA];

  return {
    winnerContent: newer.content,
    loserContent: older.content,
    needsConflictFile: true,
  };
}

import { describe, it, expect } from 'vitest';
import { threeWayMerge, resolveConflict } from '../src/conflict-resolver';
import type { SyncDocument } from '../src/types';

function makeDoc(overrides: Partial<SyncDocument>): SyncDocument {
  return {
    _id: 'test.md',
    content: 'test content',
    contentType: 'text',
    mtime: Date.now(),
    size: 12,
    hash: 'abc123',
    ...overrides,
  };
}

describe('threeWayMerge', () => {
  it('clean merge when different parts of file are edited', () => {
    const ancestor = 'line1\nline2\nline3';
    const versionA = 'line1-edited\nline2\nline3';
    const versionB = 'line1\nline2\nline3-edited';

    const result = threeWayMerge(ancestor, versionA, versionB);

    expect(result.clean).toBe(true);
    expect(result.merged).toBe('line1-edited\nline2\nline3-edited');
  });

  it('identical changes produce correct merged result', () => {
    const ancestor = 'aaa\nbbb\nccc\nddd\neee';
    const versionA = 'aaa\nXXX\nccc\nddd\neee';
    const versionB = 'aaa\nXXX\nccc\nddd\neee';

    const result = threeWayMerge(ancestor, versionA, versionB);

    expect(result.clean).toBe(true);
    expect(result.merged).toBe('aaa\nXXX\nccc\nddd\neee');
  });

  it('conflicting overlapping edits produce a dirty merge', () => {
    // diff-match-patch needs enough context to fail fuzzy matching.
    // Use a realistic scenario: large overlapping block rewrites.
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`line ${i} original content here`);
    const ancestor = lines.join('\n');

    const linesA = lines.map((l, i) =>
      i >= 5 && i <= 15 ? `line ${i} version A rewrote this` : l,
    );
    const linesB = lines.map((l, i) =>
      i >= 5 && i <= 15 ? `line ${i} version B rewrote this` : l,
    );

    const result = threeWayMerge(ancestor, linesA.join('\n'), linesB.join('\n'));

    expect(result.clean).toBe(false);
  });
});

describe('resolveConflict', () => {
  it('binary files: newer mtime wins, no conflict file', () => {
    const older = makeDoc({
      _id: 'image.png',
      contentType: 'binary',
      content: 'old-binary-data',
      mtime: 1000,
    });
    const newer = makeDoc({
      _id: 'image.png',
      contentType: 'binary',
      content: 'new-binary-data',
      mtime: 2000,
    });

    const result = resolveConflict(null, older, newer);

    expect(result.winnerContent).toBe('new-binary-data');
    expect(result.loserContent).toBeNull();
    expect(result.needsConflictFile).toBe(false);
  });

  it('text with ancestor, clean merge: no conflict file', () => {
    const ancestor = makeDoc({
      content: 'line1\nline2\nline3',
      mtime: 1000,
    });
    const versionA = makeDoc({
      content: 'line1-edited\nline2\nline3',
      mtime: 2000,
    });
    const versionB = makeDoc({
      content: 'line1\nline2\nline3-edited',
      mtime: 3000,
    });

    const result = resolveConflict(ancestor, versionA, versionB);

    expect(result.winnerContent).toBe('line1-edited\nline2\nline3-edited');
    expect(result.loserContent).toBeNull();
    expect(result.needsConflictFile).toBe(false);
  });

  it('text with ancestor, dirty merge: conflict file with loser content', () => {
    // Use a large overlapping rewrite to trigger a genuinely dirty merge
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`line ${i} original content here`);
    const ancestorContent = lines.join('\n');

    const linesA = lines.map((l, i) =>
      i >= 5 && i <= 15 ? `line ${i} version A rewrote this` : l,
    );
    const linesB = lines.map((l, i) =>
      i >= 5 && i <= 15 ? `line ${i} version B rewrote this` : l,
    );

    const ancestor = makeDoc({ content: ancestorContent, mtime: 1000 });
    const versionA = makeDoc({ content: linesA.join('\n'), mtime: 2000 });
    const versionB = makeDoc({ content: linesB.join('\n'), mtime: 3000 });

    const result = resolveConflict(ancestor, versionA, versionB);

    expect(result.needsConflictFile).toBe(true);
    expect(result.loserContent).toBe(linesB.join('\n'));
  });

  it('text without ancestor: newer mtime wins, older becomes conflict file', () => {
    const older = makeDoc({
      content: 'older version',
      mtime: 1000,
    });
    const newer = makeDoc({
      content: 'newer version',
      mtime: 2000,
    });

    const result = resolveConflict(null, older, newer);

    expect(result.winnerContent).toBe('newer version');
    expect(result.loserContent).toBe('older version');
    expect(result.needsConflictFile).toBe(true);
  });

  it('text without ancestor, same mtime: versionA wins (stable)', () => {
    const now = Date.now();
    const versionA = makeDoc({
      content: 'version A content',
      mtime: now,
    });
    const versionB = makeDoc({
      content: 'version B content',
      mtime: now,
    });

    const result = resolveConflict(null, versionA, versionB);

    expect(result.winnerContent).toBe('version A content');
    expect(result.loserContent).toBe('version B content');
    expect(result.needsConflictFile).toBe(true);
  });
});

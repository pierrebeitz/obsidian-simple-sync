import { describe, it, expect } from 'vitest';
import { computeHash, computeHashBinary } from '../src/hasher';

describe('computeHash', () => {
  it('returns consistent hash for same input', async () => {
    const hash1 = await computeHash('hello world');
    const hash2 = await computeHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different input', async () => {
    const hash1 = await computeHash('hello world');
    const hash2 = await computeHash('goodbye world');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a 16-character hex string', async () => {
    const hash = await computeHash('test content');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('computeHashBinary', () => {
  it('works with ArrayBuffer', async () => {
    const buffer = new TextEncoder().encode('binary data').buffer as ArrayBuffer;
    const hash = await computeHashBinary(buffer);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('computeHash and computeHashBinary consistency', () => {
  it('return the same hash for the same content', async () => {
    const content = 'identical content';
    const hashFromString = await computeHash(content);
    const buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
    const hashFromBinary = await computeHashBinary(buffer);
    expect(hashFromString).toBe(hashFromBinary);
  });
});

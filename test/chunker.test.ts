import { describe, it, expect } from 'vitest';
import { chunkId, splitIntoChunks, reassembleChunks } from '../src/chunker';
import { CHUNK_SIZE } from '../src/types';

describe('chunkId', () => {
  it('generates correct format with zero-padded index', () => {
    expect(chunkId('doc.md', 0)).toBe('chunk:doc.md:000000');
    expect(chunkId('doc.md', 1)).toBe('chunk:doc.md:000001');
    expect(chunkId('doc.md', 42)).toBe('chunk:doc.md:000042');
    expect(chunkId('doc.md', 999999)).toBe('chunk:doc.md:999999');
  });
});

describe('splitIntoChunks', () => {
  it('creates correct number of chunks for given data size', () => {
    const data = 'x'.repeat(CHUNK_SIZE * 3 + 100);
    const chunks = splitIntoChunks('parent.md', data);
    expect(chunks).toHaveLength(4);
  });

  it('preserves all data when reassembled', () => {
    const data = 'abcdef'.repeat(CHUNK_SIZE);
    const chunks = splitIntoChunks('parent.md', data);
    const reassembled = chunks.map((c) => c.data).join('');
    expect(reassembled).toBe(data);
  });

  it('returns empty array for empty string', () => {
    const chunks = splitIntoChunks('empty.md', '');
    expect(chunks).toEqual([]);
  });

  it('returns single chunk for data smaller than CHUNK_SIZE', () => {
    const data = 'small data';
    const chunks = splitIntoChunks('small.md', data);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].data).toBe(data);
    expect(chunks[0]._id).toBe('chunk:small.md:000000');
  });
});

describe('reassembleChunks', () => {
  it('handles chunks in wrong order by sorting on _id', () => {
    const data = 'a'.repeat(CHUNK_SIZE) + 'b'.repeat(CHUNK_SIZE) + 'c'.repeat(100);
    const chunks = splitIntoChunks('order.md', data);

    // Reverse the order to simulate out-of-order chunks
    const reversed = [...chunks].reverse();
    const reassembled = reassembleChunks(reversed);
    expect(reassembled).toBe(data);
  });
});

describe('round-trip: split then reassemble', () => {
  it('equals original data', () => {
    const original = 'The quick brown fox jumps over the lazy dog.\n'.repeat(50000);
    const chunks = splitIntoChunks('roundtrip.md', original);
    const reassembled = reassembleChunks(chunks);
    expect(reassembled).toBe(original);
  });
});

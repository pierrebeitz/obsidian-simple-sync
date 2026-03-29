import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      'pouchdb-browser': path.resolve(__dirname, 'test/pouchdb-node.ts'),
    },
  },
});

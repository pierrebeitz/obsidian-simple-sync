import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['test/e2e/**', 'node_modules/**'],
    alias: {
      'pouchdb-browser': path.resolve(__dirname, 'test/pouchdb-node.ts'),
    },
  },
});

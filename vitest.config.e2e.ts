import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    alias: {
      "pouchdb-browser": path.resolve(__dirname, "test/pouchdb-node.ts"),
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

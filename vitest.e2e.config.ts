import { defineConfig } from "vitest/config";

// The slow tests: each starts an in-process blockchain (Ganache). Their setup now sends
// transactions in parallel, so they are quick enough to run several files at once.
export default defineConfig({
  test: {
    include: ["test/**/*e2e*.test.ts", "test/fast.test.ts", "test/drops.test.ts", "test/snipe.test.ts"],
    // The multi-user file is the heaviest and is sensitive to CPU load: it runs alone (see test:e2e).
    exclude: ["**/node_modules/**", "**/tg-e2e.test.ts"],
    fileParallelism: true,
    maxWorkers: 4,
    hookTimeout: 240_000,
    testTimeout: 240_000,
  },
});

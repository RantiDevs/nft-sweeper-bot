import { defineConfig } from "vitest/config";

// The multi-user Telegram hub test is the heaviest slow test and is sensitive to CPU load,
// so it runs on its own after the other slow tests (see `npm run test:e2e`).
export default defineConfig({
  test: {
    include: ["test/tg-e2e.test.ts"],
    fileParallelism: false,
    hookTimeout: 240_000,
    testTimeout: 240_000,
  },
});

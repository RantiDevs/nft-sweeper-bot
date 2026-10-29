import { defineConfig } from "vitest/config";

// `npm test`: the fast set. The slow tests that boot a whole local blockchain run with
// `npm run test:e2e` (see vitest.e2e.config.ts).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*e2e*.test.ts", "**/fast.test.ts", "**/drops.test.ts", "**/snipe.test.ts"],
    testTimeout: 30_000,
  },
});

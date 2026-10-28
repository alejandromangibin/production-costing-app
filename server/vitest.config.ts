import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one real PostgreSQL when TEST_DATABASE_URL is set, so they must take turns.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The date tests expect Manila time, whatever a developer's .env or CI sets.
    env: { APP_TIME_ZONE: 'Asia/Manila' },
  },
});

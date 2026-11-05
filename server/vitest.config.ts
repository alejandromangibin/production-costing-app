import { defineConfig } from 'vitest/config';

// A run meant for PostgreSQL must not quietly pass on the built-in database instead.
if (process.env.npm_lifecycle_event === 'test:postgres' && !process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is empty, so this would not test PostgreSQL. Run npm.cmd run test:db:setup first.');
}

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

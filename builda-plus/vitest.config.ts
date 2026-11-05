import { defineConfig } from 'vitest/config';
// Integration test files share one database, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });

import { defineConfig } from 'vitest/config';
import { boundedForkPool } from '../../scripts/vitest-pool.mjs';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    ...boundedForkPool(),
  }
});